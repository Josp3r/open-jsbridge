import assert from 'node:assert/strict';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { ErrorCode } from '../dist/packages/protocol/src/index.js';
import {
  canonicalHttpsOrigin,
  createOriginAllowlist,
  createReactNativeHost,
  encodeReceiveScript,
  HostError,
  OJSB_RN_SHIM,
} from '../dist/packages/react-native/src/index.js';
import { createBridge } from '../dist/packages/web-sdk/src/index.js';

function createShimContext({ isMainFrame = true, onPostMessage = () => {} } = {}) {
  const errors = [];
  const target = new EventTarget();
  const win = Object.assign(target, {
    ReactNativeWebView: { postMessage: onPostMessage },
  });
  win.top = isMainFrame ? win : {};
  const ctx = createContext({
    window: win,
    CustomEvent: class CustomEvent extends Event {
      constructor(type) { super(type); }
    },
    setTimeout: (fn) => errors.push(fn),
  });
  runInContext(OJSB_RN_SHIM, ctx);
  return { win, ctx, errors };
}

test('OJSB_RN_SHIM installs a frozen main-frame transport and buffers early messages safely', () => {
  const iframe = createShimContext({ isMainFrame: false });
  assert.equal(iframe.win.__OJSB_TRANSPORT__, undefined);

  const posted = [];
  const main = createShimContext({ onPostMessage: (raw) => posted.push(raw) });
  assert.equal(main.win.__OJSB_TRANSPORT__.name, 'rn');
  assert.deepEqual([...main.win.__OJSB_TRANSPORT__.protocols], [1]);
  assert.equal(Object.isFrozen(main.win.__OJSB_TRANSPORT__), true);

  main.win.__OJSB_TRANSPORT__.postMessage('{"ping":1}');
  assert.deepEqual(posted, ['{"ping":1}']);

  // Buffer survives clearing receiver and continues draining if receiver throws.
  main.win.__OJSB_RECEIVE__('first');
  main.win.__OJSB_RECEIVE__ = undefined;
  main.win.__OJSB_RECEIVE__('second');
  assert.equal(main.errors.length, 0);

  const received = [];
  main.win.__OJSB_RECEIVE__ = (msg) => {
    if (msg === 'first') throw new Error('boom');
    received.push(msg);
  };
  assert.deepEqual(received, ['second']);
  assert.equal(main.errors.length, 1);
});

test('encodeReceiveScript double-encodes special characters and line separators without injection', () => {
  const delivered = [];
  const ctx = createContext({
    window: { __OJSB_RECEIVE__: (msg) => delivered.push(msg) },
  });
  const payload = JSON.stringify({
    text: 'quote"\'\\</script>\nline\u2028sep\u2029end',
  });
  const script = encodeReceiveScript(payload);
  assert.equal(script.includes('\u2028'), false);
  assert.equal(script.includes('\u2029'), false);
  runInContext(script, ctx);
  assert.deepEqual(delivered, [payload]);
});

test('origin allowlist enforces exact HTTPS origins and rejects prefix/scheme/port mismatches', () => {
  assert.equal(canonicalHttpsOrigin('https://m.acme.com:443/path'), 'https://m.acme.com');
  assert.equal(canonicalHttpsOrigin('https://m.acme.com:8443/path'), 'https://m.acme.com:8443');
  for (const bad of [
    'http://m.acme.com',
    'file:///index.html',
    'data:text/html,hi',
    'about:blank',
    'https://user:pass@m.acme.com',
    'https://*.acme.com',
  ]) {
    assert.equal(canonicalHttpsOrigin(bad), undefined, bad);
  }

  assert.throws(() => createOriginAllowlist([]), RangeError);
  assert.throws(() => createOriginAllowlist(['http://m.acme.com']), RangeError);
  assert.throws(() => createOriginAllowlist(['https://*.acme.com']), RangeError);
  assert.throws(() => createOriginAllowlist(['https://m.acme.com/app']), RangeError);

  const acl = createOriginAllowlist(['https://m.acme.com']);
  assert.equal(acl.allowsUrl('https://m.acme.com/home'), true);
  assert.equal(acl.allowsUrl('https://m.acme.com:443/home'), true);
  assert.equal(acl.allowsUrl('https://m.acme.com:8443/home'), false);
  assert.equal(acl.allowsUrl('https://m.acme.com.evil.test/home'), false);
  assert.equal(acl.allowsUrl('http://m.acme.com/home'), false);
});

test('ReactNativeHost is disabled by default (protocol S2) and blocks untrusted sources', async () => {
  const injected = [];
  const disabledHost = createReactNativeHost({
    allowedOrigins: ['https://m.acme.com'],
    handlers: { 'acme.ping': () => ({ ok: true }) },
  });
  assert.equal(disabledHost.trust, 'degraded');
  assert.equal(disabledHost.isEnabled, false);
  disabledHost.attach({ injectJavaScript: (s) => injected.push(s) });

  const disabledProps = disabledHost.bindWebViewProps({ sourceUri: 'https://m.acme.com/home' });
  assert.equal(disabledProps.injectedJavaScriptBeforeContentLoaded, undefined);
  assert.equal(await disabledHost.handleMessage(JSON.stringify({
    jsb: '1.0',
    rpc: { jsonrpc: '2.0', id: 'h-1', method: 'bridge.hello', params: { protocols: [1] } },
  })), false);
  assert.deepEqual(injected, []);

  // Even when degraded mode is opted in, untrusted initial sourceUri disables shim injection.
  const blocked = [];
  const enabledHost = createReactNativeHost({
    allowedOrigins: ['https://m.acme.com'],
    allowDegradedTransport: true,
    onBlockedNavigation: (url) => blocked.push(url),
  });
  enabledHost.attach({ injectJavaScript: (s) => injected.push(s) });
  const untrustedProps = enabledHost.bindWebViewProps({ sourceUri: 'https://m.acme.com.evil.test/' });
  assert.equal(untrustedProps.injectedJavaScriptBeforeContentLoaded, undefined);
  assert.equal(enabledHost.shouldStartLoad('https://m.acme.com.evil.test/next'), false);
  assert.deepEqual(blocked, ['https://m.acme.com.evil.test/next']);
});

test('ReactNativeHost runs Web SDK end-to-end across OJSB_RN_SHIM and isolates navigation/crashes', async (t) => {
  let resolveSlow;
  let slowAborted = false;
  const host = createReactNativeHost({
    allowedOrigins: ['https://m.acme.com'],
    allowDegradedTransport: true,
    events: ['network.statusChanged'],
    handlers: {
      'device.getInfo': () => ({ os: 'ios', osVersion: '18.2' }),
      'acme.stream': async (_params, ctx) => {
        ctx.callback({ pct: 50 });
        ctx.callback({ pct: 100 });
        return { done: true };
      },
      'acme.slow': (_params, ctx) => new Promise((resolve) => {
        resolveSlow = resolve;
        ctx.signal.addEventListener('abort', () => { slowAborted = true; }, { once: true });
      }),
      'acme.fail': () => {
        throw new HostError(ErrorCode.UserDenied, 'User denied');
      },
    },
  });

  let webViewProps;
  const { win, ctx } = createShimContext({
    onPostMessage(raw) {
      webViewProps.onMessage?.({ nativeEvent: { data: raw, isMainFrame: true } });
    },
  });

  const injectedScripts = [];
  const detach = host.attach({
    injectJavaScript(script) {
      injectedScripts.push(script);
      runInContext(script, ctx);
    },
  });
  webViewProps = host.bindWebViewProps({ sourceUri: 'https://m.acme.com/app' });
  assert.equal(webViewProps.injectedJavaScriptBeforeContentLoaded, OJSB_RN_SHIM);
  assert.equal(webViewProps.injectedJavaScriptBeforeContentLoadedForMainFrameOnly, true);

  Object.defineProperty(globalThis, 'window', { value: win, configurable: true });
  t.after(() => {
    detach();
    delete globalThis.window;
  });

  const bridge = createBridge();
  t.after(() => bridge.close());

  const info = await bridge.call('device.getInfo');
  assert.deepEqual(info, { os: 'ios', osVersion: '18.2' });

  // Streaming progress callbacks work end-to-end across injectJavaScript.
  const chunks = [];
  const streamResult = await bridge.call('acme.stream', {}, {
    onCallback: (chunk, seq) => chunks.push([seq, chunk]),
  });
  assert.deepEqual(streamResult, { done: true });
  assert.deepEqual(chunks, [[0, { pct: 50 }], [1, { pct: 100 }]]);

  // Structured HostError propagates cleanly.
  await assert.rejects(bridge.call('acme.fail'), { code: ErrorCode.UserDenied });

  // Subscribed events are pushed via double-encoded injectJavaScript.
  const events = [];
  const off = bridge.on('network.statusChanged', (payload) => events.push(payload));
  await off.ready;
  assert.equal(host.emit('network.statusChanged', { type: 'wifi' }), true);
  assert.deepEqual(events, [{ type: 'wifi' }]);
  off();

  // Sub-frame messages are dropped.
  assert.equal(await host.handleMessage(JSON.stringify({
    jsb: '1.0',
    meta: { sid: host.sid },
    rpc: { jsonrpc: '2.0', id: 'sub-1', method: 'device.getInfo' },
  }), { isMainFrame: false }), false);

  // Process termination aborts inflight handler and suppresses late replies.
  const beforeCrashCount = injectedScripts.length;
  const slowPromise = bridge.call('acme.slow', {}, { timeout: 200 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  webViewProps.onRenderProcessGone?.();
  assert.equal(slowAborted, true);
  resolveSlow?.({ stale: true });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(injectedScripts.length, beforeCrashCount);
  await assert.rejects(slowPromise, { code: ErrorCode.Timeout });
});
