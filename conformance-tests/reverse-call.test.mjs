import assert from 'node:assert/strict';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { encodeEnvelope, ErrorCode } from '../dist/packages/protocol/src/index.js';
import { createHostCore, HostError } from '../dist/packages/host-core/src/index.js';
import { createReactNativeHost, OJSB_RN_SHIM } from '../dist/packages/react-native/src/index.js';
import { createMockAdapter, installMockTransport } from '../dist/packages/web-mock/src/index.js';
import { BridgeError, createBridge } from '../dist/packages/web-sdk/src/index.js';
import { createReverseHandlers } from '../dist/packages/web-sdk/src/reverse.js';

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

test('handshake wants includes reverse only when createReverseHandlers is attached', async () => {
  const seenWants = [];
  const baseAdapter = createMockAdapter({ supportsReverse: true });
  const spyAdapter = {
    name: baseAdapter.name,
    listen: (cb) => baseAdapter.listen(cb),
    send(raw) {
      const env = JSON.parse(raw);
      if (env.rpc?.method === 'bridge.hello') {
        seenWants.push([...(env.rpc.params?.wants ?? [])]);
      }
      return baseAdapter.send(raw);
    },
  };

  const plainBridge = createBridge({ adapter: spyAdapter });
  await plainBridge.ready();
  plainBridge.close();

  const reverseBridge = createBridge({ adapter: spyAdapter });
  const reverse = createReverseHandlers(reverseBridge);
  assert.throws(() => createReverseHandlers(reverseBridge));
  assert.throws(() => createReverseHandlers({}));
  assert.throws(() => reverse.handle('invalid', () => null), TypeError);
  assert.throws(() => reverse.handle('bridge.hello', () => null), TypeError);
  assert.throws(() => reverse.handle('rpc.ping', () => null), TypeError);
  assert.throws(() => reverse.handle('ojsb.internal', () => null), TypeError);
  assert.throws(() => reverse.handle('page.share', 'not-a-fn'), TypeError);

  await reverseBridge.ready();
  reverseBridge.close();

  assert.equal(seenWants.length, 2);
  assert.equal(seenWants[0].includes('reverse'), false);
  assert.equal(seenWants[1].includes('reverse'), true);
});

test('registerWebMethods tracks web handlers across register, unregister, empty clear, and reconnect', async () => {
  const adapter = createMockAdapter({ supportsReverse: true });
  const bridge = createBridge({ adapter });
  const reverse = createReverseHandlers(bridge);

  const offShare = reverse.handle('page.getShareInfo', () => ({ title: 'Home' }));
  assert.deepEqual(reverse.methods(), ['page.getShareInfo']);
  assert.equal(adapter.webMethods.size, 0);

  await bridge.ready();
  await flushMicrotasks();
  assert.deepEqual([...adapter.webMethods], ['page.getShareInfo']);

  const offBack = reverse.handle('page.canGoBack', () => ({ canGoBack: true }));
  await flushMicrotasks();
  assert.deepEqual([...adapter.webMethods].sort(), ['page.canGoBack', 'page.getShareInfo']);

  // Calling offBack twice is idempotent; replacing a handler keeps the replacement safe from old off().
  offBack();
  offBack();
  await flushMicrotasks();
  assert.deepEqual([...adapter.webMethods], ['page.getShareInfo']);

  // Reconnect re-registers active web handlers on the new session.
  await bridge.reconnect();
  await flushMicrotasks();
  assert.deepEqual([...adapter.webMethods], ['page.getShareInfo']);

  // Removing the last handler clears adapter.webMethods cleanly.
  offShare();
  await flushMicrotasks();
  assert.deepEqual([...adapter.webMethods], []);

  bridge.close();
});

test('callWeb dispatches success, void->null, versioned methods, errors, dedup, and size limits', async () => {
  const adapter = createMockAdapter({
    supportsReverse: true,
    limits: { maxMessageBytes: 1024 },
  });
  let pushRaw;
  let capturedSid;
  const wrappedAdapter = {
    name: adapter.name,
    listen(cb) {
      pushRaw = cb;
      return adapter.listen(cb);
    },
    async send(raw) {
      const reply = await adapter.send(raw);
      if (reply) {
        const parsed = JSON.parse(reply);
        if (parsed.rpc?.result?.sid) capturedSid = parsed.rpc.result.sid;
      }
      return reply;
    },
  };

  const bridge = createBridge({ adapter: wrappedAdapter });
  const reverse = createReverseHandlers(bridge);

  let dedupRuns = 0;
  reverse.handle('page.getShareInfo', (params) => ({
    title: `Title:${params?.slug ?? ''}`,
  }));
  reverse.handle('page.ping', () => undefined);
  reverse.handle('page.failTyped', () => {
    throw new BridgeError(ErrorCode.PermissionDenied, 'User declined', { data: { reason: 'denied' } });
  });
  reverse.handle('page.failSecret', () => {
    throw new Error('secret-stack-token');
  });
  reverse.handle('page.tooBig', () => ({ blob: 'x'.repeat(2048) }));
  reverse.handle('page.countOnce', () => ({ runs: ++dedupRuns }));

  await bridge.ready();
  await flushMicrotasks();

  assert.deepEqual(
    await adapter.callWeb('page.getShareInfo', { slug: 'docs' }),
    { title: 'Title:docs' },
  );
  assert.deepEqual(
    await adapter.callWeb('page.getShareInfo@1', { slug: 'v1' }),
    { title: 'Title:v1' },
  );
  assert.equal(await adapter.callWeb('page.ping'), null);

  await assert.rejects(
    adapter.callWeb('page.failTyped'),
    (error) => error instanceof HostError &&
      error.code === ErrorCode.PermissionDenied &&
      error.message === 'User declined' &&
      error.data?.reason === 'denied',
  );

  await assert.rejects(
    adapter.callWeb('page.failSecret'),
    (error) => error instanceof HostError &&
      error.code === ErrorCode.InternalError &&
      error.message === 'Internal error' &&
      !error.message.includes('secret-stack-token'),
  );

  await assert.rejects(
    adapter.callWeb('page.missing'),
    (error) => error instanceof HostError && error.code === ErrorCode.MethodNotFound,
  );

  await assert.rejects(
    adapter.callWeb('page.tooBig'),
    (error) => error instanceof HostError && error.code === ErrorCode.PayloadTooLarge,
  );

  await assert.rejects(
    adapter.callWeb('page.getShareInfo', { blob: 'y'.repeat(2048) }),
    (error) => error instanceof HostError && error.code === ErrorCode.PayloadTooLarge,
  );

  // Duplicate inbound request id within the same session must only execute once.
  const dupFrame = encodeEnvelope({
    jsb: '1.0',
    meta: { sid: capturedSid, ts: Date.now(), timeout: 5000 },
    rpc: { jsonrpc: '2.0', id: 'dup-1', method: 'page.countOnce' },
  });
  pushRaw(dupFrame);
  pushRaw(dupFrame);
  await flushMicrotasks();
  assert.equal(dedupRuns, 1);

  bridge.close();

  // Host without supportsReverse rejects callWeb and bridge.registerWebMethods with MethodNotFound.
  const disabledHost = createHostCore();
  await assert.rejects(
    disabledHost.callWeb('page.ping'),
    (error) => error instanceof HostError && error.code === ErrorCode.MethodNotFound,
  );
});

test('callWeb timeout and AbortSignal send bridge.cancel and abort Web handler signal', async () => {
  const adapter = createMockAdapter({ supportsReverse: true });
  const bridge = createBridge({ adapter });
  const reverse = createReverseHandlers(bridge);

  const abortReasons = [];
  reverse.handle('page.slow', (_params, ctx) => new Promise((resolve) => {
    ctx.signal.addEventListener('abort', () => {
      abortReasons.push('aborted');
      resolve({ late: true });
    }, { once: true });
  }));

  await bridge.ready();
  await flushMicrotasks();

  await assert.rejects(
    adapter.callWeb('page.slow', undefined, { timeout: 30 }),
    (error) => error instanceof HostError && error.code === ErrorCode.Timeout,
  );
  await flushMicrotasks();
  assert.equal(abortReasons.length, 1);

  const controller = new AbortController();
  const pending = adapter.callWeb('page.slow', undefined, { timeout: 5000, signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(
    pending,
    (error) => error instanceof HostError && error.code === ErrorCode.Cancelled,
  );
  await flushMicrotasks();
  assert.equal(abortReasons.length, 2);

  bridge.close();
});

test('session invalidation aborts inflight Web handlers, rejects Host callWeb, and suppresses late replies', async () => {
  const adapter = createMockAdapter({ supportsReverse: true });
  const sentFrames = [];
  const spyAdapter = {
    name: adapter.name,
    listen: (cb) => adapter.listen(cb),
    send(raw) {
      sentFrames.push(JSON.parse(raw));
      return adapter.send(raw);
    },
  };
  const bridge = createBridge({ adapter: spyAdapter });
  const reverse = createReverseHandlers(bridge);

  let aborted = false;
  let releaseHandler;
  reverse.handle('page.hold', (_params, ctx) => new Promise((resolve) => {
    ctx.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    releaseHandler = () => resolve({ late: true });
  }));

  await bridge.ready();
  await flushMicrotasks();

  const inflightCall = adapter.callWeb('page.hold', undefined, { timeout: 5000 });
  await flushMicrotasks();
  const frameCountBeforeClose = sentFrames.length;

  bridge.close();
  await assert.rejects(
    inflightCall,
    (error) => error instanceof HostError && error.code === ErrorCode.Cancelled,
  );
  assert.equal(aborted, true);

  // Even if the handler resolves later, no late reply is posted to the retired session.
  releaseHandler();
  await flushMicrotasks();
  assert.equal(sentFrames.length, frameCountBeforeClose);
});

test('installMockTransport and ReactNativeHost support callWeb end-to-end', async (t) => {
  // 1. Browser mock transport handle
  const prevWindow = globalThis.window;
  t.after(() => { globalThis.window = prevWindow; });
  globalThis.window = new EventTarget();

  const mockHandle = installMockTransport({ supportsReverse: true });
  assert.ok(mockHandle);
  const browserBridge = createBridge();
  const browserReverse = createReverseHandlers(browserBridge);
  browserReverse.handle('page.title', () => ({ title: 'Browser Mock' }));
  await browserBridge.ready();
  await flushMicrotasks();
  assert.deepEqual([...mockHandle.webMethods], ['page.title']);
  assert.deepEqual(await mockHandle.callWeb('page.title'), { title: 'Browser Mock' });
  browserBridge.close();

  // 2. ReactNativeHost Scheme A end-to-end via OJSB_RN_SHIM
  const disabledHost = createReactNativeHost({ allowedOrigins: ['https://app.acme.com'] });
  await assert.rejects(
    disabledHost.callWeb('page.title'),
    (error) => error instanceof HostError && error.code === ErrorCode.Unavailable,
  );

  const rnHost = createReactNativeHost({
    allowedOrigins: ['https://app.acme.com'],
    allowDegradedTransport: true,
  });

  const win = Object.assign(new EventTarget(), {
    ReactNativeWebView: {
      postMessage(raw) {
        void rnHost.handleMessage(raw, { url: 'https://app.acme.com/home', isMainFrame: true });
      },
    },
  });
  win.top = win;
  const ctx = createContext({
    window: win,
    CustomEvent: class CustomEvent extends Event {
      constructor(type) { super(type); }
    },
    setTimeout,
  });
  runInContext(OJSB_RN_SHIM, ctx);

  const detach = rnHost.attach({
    injectJavaScript(script) {
      runInContext(script, ctx);
    },
  });
  rnHost.onDocumentCommit('https://app.acme.com/home');

  const rnAdapter = {
    name: 'rn',
    protocols: [1],
    send(raw) {
      win.__OJSB_TRANSPORT__.postMessage(raw);
    },
    listen(onMessage) {
      win.__OJSB_RECEIVE__ = onMessage;
      return () => {
        if (win.__OJSB_RECEIVE__ === onMessage) win.__OJSB_RECEIVE__ = undefined;
      };
    },
  };

  const rnBridge = createBridge({ adapter: rnAdapter });
  const rnReverse = createReverseHandlers(rnBridge);
  rnReverse.handle('page.getShareInfo', (params) => ({
    title: 'RN Page',
    channel: params?.channel ?? 'default',
  }));

  await rnBridge.ready();
  await flushMicrotasks();
  assert.deepEqual([...rnHost.webMethods], ['page.getShareInfo']);
  assert.deepEqual(
    await rnHost.callWeb('page.getShareInfo', { channel: 'wechat' }),
    { title: 'RN Page', channel: 'wechat' },
  );

  // Detaching target invalidates session and rejects subsequent callWeb.
  detach();
  assert.equal(rnHost.webMethods.size, 0);
  await assert.rejects(
    rnHost.callWeb('page.getShareInfo'),
    (error) => error instanceof HostError && error.code === ErrorCode.Unavailable,
  );
  rnBridge.close();
});
