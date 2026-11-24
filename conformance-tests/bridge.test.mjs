import assert from 'node:assert/strict';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { bridge, BridgeError, createBridge, ErrorCode } from '../dist/packages/web-sdk/src/index.js';
import { createMockAdapter } from '../dist/packages/web-mock/src/index.js';

const echo = 'conformance.echo';
const host = { platform: 'mock', name: 'mock', version: '0.1.0' };
const hello = {
  jsb: '1.0',
  sid: 'test-session',
  host,
  capabilities: { methods: { [echo]: { versions: [1] } }, events: [], features: ['cancel'] },
  limits: { maxMessageBytes: 1_048_576, maxInflight: 64, defaultTimeoutMs: 15_000 },
};

function controlledTransport() {
  let receive;
  const sent = [];
  return {
    sent,
    adapter: {
      send(raw) { sent.push(JSON.parse(raw)); },
      listen(listener) { receive = listener; return () => { receive = undefined; }; },
    },
    push(raw) { receive?.(raw); },
  };
}

function frame(rpc, meta) {
  return JSON.stringify({ jsb: '1.0', meta, rpc: { jsonrpc: '2.0', ...rpc } });
}

function connect(transport, limits = {}) {
  transport.push(frame({ id: transport.sent[0].rpc.id, result: {
    ...hello, limits: { ...hello.limits, ...limits },
  } }));
}

function shimWindow(t, transport) {
  const window = new EventTarget();
  let receiver;
  const forward = (raw) => receiver?.(raw);
  Object.defineProperty(window, '__OJSB_RECEIVE__', {
    get() { return forward; },
    set(value) { receiver = value; },
  });
  window.__OJSB_TRANSPORT__ = transport;
  Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
  t.after(() => { delete globalThis.window; });
  return { window, get receiver() { return receiver; } };
}

function restorePage(window) {
  const event = new Event('pageshow');
  Object.defineProperty(event, 'persisted', { value: true });
  window.dispatchEvent(event);
}

test('the default bridge can be imported and used without a browser', async () => {
  assert.equal(bridge.state, 'idle');
  await assert.rejects(bridge.ready(), { code: ErrorCode.Unavailable });
  assert.equal(bridge.state, 'unavailable');
});

test('Web and Mock negotiate once and echo concurrent requests without crossing results', async () => {
  const client = createBridge({ adapter: createMockAdapter() });
  const results = await Promise.all([
    client.ready(),
    client.ready(),
    client.call(echo, { text: '你好', values: [1, null, true] }),
    client.call(`${echo}@1`, { text: 'second' }),
  ]);
  assert.deepEqual(results, [host, host, { text: '你好', values: [1, null, true] }, { text: 'second' }]);
  assert.equal(client.state, 'ready');
  assert.equal(client.has(echo), true);
  assert.equal(client.has(echo, 1), true);
  assert.equal(client.has(echo, 2), false);
});

test('maxInflight preserves call order across the handshake and ready state', async (t) => {
  const transport = controlledTransport();
  const client = createBridge({ adapter: transport.adapter });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const first = client.call(echo, { order: 1 }, { signal: controller.signal });
  const second = client.call(echo, { order: 2 }, { signal: controller.signal });
  await setImmediate();
  connect(transport, { maxInflight: 1 });
  await client.ready();
  const third = client.call(echo, { order: 3 }, { signal: controller.signal });
  const results = Promise.all([first, second, third]);
  void results.catch(() => {});

  const sentOrders = () => transport.sent.slice(1).map(({ rpc }) => rpc.params.order);
  assert.deepEqual(sentOrders(), [1]);
  transport.push(frame({ id: transport.sent[1].rpc.id, result: 'one' }, { sid: hello.sid }));
  await setImmediate();
  assert.deepEqual(sentOrders(), [1, 2]);
  transport.push(frame({ id: transport.sent[2].rpc.id, result: 'two' }, { sid: hello.sid }));
  await setImmediate();
  assert.deepEqual(sentOrders(), [1, 2, 3]);
  transport.push(frame({ id: transport.sent[3].rpc.id, result: 'three' }, { sid: hello.sid }));
  assert.deepEqual(await results, ['one', 'two', 'three']);
});

test('maxInflight rejects unsupported calls from before ready while the only slot is occupied', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const transport = controlledTransport();
  const client = createBridge({ adapter: transport.adapter });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const options = { signal: controller.signal };
  const first = client.call(echo, {}, options);
  void first.catch(() => {});
  const unsupported = client.call(echo, {}, { ...options, version: 2 });
  const expired = client.call('unknown.method', {}, { ...options, timeout: 10 });
  const settled = Promise.allSettled([unsupported, expired]);
  await setImmediate();
  now = 10;
  connect(transport, { maxInflight: 1 });
  await client.ready();

  const rejections = await Promise.race([settled, setImmediate()]);
  assert.deepEqual(rejections?.map(({ reason }) => reason?.code), [ErrorCode.MethodNotFound, ErrorCode.Timeout]);
  assert.equal(rejections[0].reason.data.reason, 'version_unsupported');
  assert.deepEqual(transport.sent.map(({ rpc }) => rpc.method), ['bridge.hello', echo]);
  transport.push(frame({ id: transport.sent[1].rpc.id, result: true }, { sid: hello.sid }));
  assert.equal(await first, true);
});

test('maxInflight drops expired and aborted waiting calls and sends cancel before the next call', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const transport = controlledTransport();
  const client = createBridge({ adapter: transport.adapter });
  const ready = client.ready();
  await setImmediate();
  connect(transport, { maxInflight: 1 });
  await ready;

  const activeController = new AbortController();
  const waitingController = new AbortController();
  const cleanup = new AbortController();
  t.after(() => {
    cleanup.abort();
    waitingController.abort();
    activeController.abort();
  });
  const abortedActive = assert.rejects(client.call(echo, {}, { signal: activeController.signal }), {
    code: ErrorCode.Cancelled,
  });
  const expired = assert.rejects(client.call(echo, {}, { timeout: 10, signal: cleanup.signal }), {
    code: ErrorCode.Timeout,
  });
  const abortedWaiting = assert.rejects(client.call(echo, {}, { signal: waitingController.signal }), {
    code: ErrorCode.Cancelled,
  });
  const next = client.call(echo, { next: true }, { timeout: 1000, signal: cleanup.signal });
  void Promise.all([abortedActive, expired, abortedWaiting, next]).catch(() => {});
  const sentMethods = () => transport.sent.map(({ rpc }) => rpc.method);
  assert.deepEqual(sentMethods(), ['bridge.hello', echo]);

  waitingController.abort();
  now = 10;
  t.mock.timers.tick(10);
  await Promise.all([expired, abortedWaiting]);
  assert.deepEqual(sentMethods(), ['bridge.hello', echo]);

  activeController.abort();
  await abortedActive;
  await setImmediate();
  assert.deepEqual(sentMethods(), ['bridge.hello', echo, 'bridge.cancel', echo]);
  assert.deepEqual(transport.sent[2].rpc.params, { requestId: transport.sent[1].rpc.id });
  assert.deepEqual(transport.sent[2].meta, { sid: hello.sid });
  assert.deepEqual(transport.sent[3].rpc.params, { next: true });
  assert.equal(transport.sent[3].meta.timeout, 990);
  transport.push(frame({ id: transport.sent[3].rpc.id, result: true }, { sid: hello.sid }));
  assert.equal(await next, true);
});

function transportWithCancelReceipts(t, onCancel) {
  const sent = [];
  const receipts = [];
  const shim = shimWindow(t, {
    name: 'with-reply', protocols: [1],
    postMessage(raw) {
      const request = JSON.parse(raw);
      sent.push(request);
      if (request.rpc.method === 'bridge.cancel') {
        onCancel?.();
        return new Promise((resolve, reject) => receipts.push({ resolve, reject }));
      }
    },
  });
  t.after(() => shim.window.dispatchEvent(new Event('pagehide')));
  return { window: shim.window, sent, receipts, push: (raw) => shim.window.__OJSB_RECEIVE__(raw) };
}

test('asynchronous cancel receipts reserve each aborted slot until requests can be replaced', async (t) => {
  const transport = transportWithCancelReceipts(t);
  const client = createBridge({ queueLimit: 2 });
  const ready = client.ready();
  await setImmediate();
  connect(transport, { maxInflight: 2 });
  await ready;

  const controller = new AbortController();
  const aborted = [1, 2].map((order) => assert.rejects(
    client.call(echo, { order }, { signal: controller.signal }),
    { code: ErrorCode.Cancelled },
  ));
  const results = Promise.all([3, 4].map((order) => client.call(echo, { order })));
  void results.catch(() => {});
  controller.abort();
  await Promise.all(aborted);

  const sentMethods = () => transport.sent.map(({ rpc }) => rpc.method);
  assert.deepEqual(sentMethods(), ['bridge.hello', echo, echo, 'bridge.cancel', 'bridge.cancel']);
  await assert.rejects(client.call(echo), { code: ErrorCode.NotReady });
  assert.deepEqual(transport.sent.slice(3).map(({ rpc }) => rpc.params.requestId), [
    transport.sent[1].rpc.id, transport.sent[2].rpc.id,
  ]);

  transport.receipts[0].resolve(null);
  await setImmediate();
  assert.deepEqual(sentMethods(), ['bridge.hello', echo, echo, 'bridge.cancel', 'bridge.cancel', echo]);
  assert.equal(transport.sent[5].rpc.params.order, 3);
  transport.receipts[1].reject(new Error('Cancel send failed'));
  await setImmediate();
  assert.equal(transport.sent[6].rpc.params.order, 4);
  for (const { rpc } of transport.sent.slice(5)) {
    transport.push(frame({ id: rpc.id, result: rpc.params.order }, { sid: hello.sid }));
  }
  assert.deepEqual(await results, [3, 4]);
});

test('an unreturned cancel receipt frees its slot at the session default timeout', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const transport = transportWithCancelReceipts(t);
  const client = createBridge();
  const ready = client.ready();
  await setImmediate();
  connect(transport, { maxInflight: 1, defaultTimeoutMs: 10 });
  await ready;

  const controller = new AbortController();
  const aborted = assert.rejects(client.call(echo, {}, { signal: controller.signal }), {
    code: ErrorCode.Cancelled,
  });
  const results = Promise.all([1, 2].map((order) => client.call(echo, { order }, { timeout: 1000 })));
  void results.catch(() => {});
  controller.abort();
  await aborted;

  now = 9;
  t.mock.timers.tick(9);
  assert.equal(transport.sent.length, 3);
  now = 10;
  t.mock.timers.tick(1);
  assert.equal(transport.sent[3]?.rpc.params.order, 1);

  transport.receipts[0].resolve(null);
  await setImmediate();
  assert.equal(transport.sent.length, 4);
  transport.push(frame({ id: transport.sent[3].rpc.id, result: 1 }, { sid: hello.sid }));
  assert.equal(transport.sent[4]?.rpc.params.order, 2);
  transport.push(frame({ id: transport.sent[4].rpc.id, result: 2 }, { sid: hello.sid }));
  assert.deepEqual(await results, [1, 2]);
});

test('cancel send reserves its slot during synchronous reentry and releases it on throw', async (t) => {
  let reentrant;
  const transport = transportWithCancelReceipts(t, () => {
    reentrant = client.call(echo);
    void reentrant.catch(() => {});
    throw new Error('Cancel send failed');
  });
  const client = createBridge({ queueLimit: 0 });
  const ready = client.ready();
  await setImmediate();
  connect(transport, { maxInflight: 1 });
  await ready;

  const controller = new AbortController();
  const aborted = assert.rejects(client.call(echo, {}, { signal: controller.signal }), {
    code: ErrorCode.Cancelled,
  });
  controller.abort();
  await aborted;
  await assert.rejects(reentrant, { code: ErrorCode.NotReady });

  const next = client.call(echo);
  void next.catch(() => {});
  assert.equal(transport.sent[3]?.rpc.method, echo);
  transport.push(frame({ id: transport.sent[3].rpc.id, result: true }, { sid: hello.sid }));
  assert.equal(await next, true);
});

test('pagehide retires the cancel receipt reservation before the restored session', async (t) => {
  const transport = transportWithCancelReceipts(t);
  const client = createBridge({ queueLimit: 0 });
  const ready = client.ready();
  await setImmediate();
  connect(transport, { maxInflight: 1 });
  await ready;

  const controller = new AbortController();
  const aborted = assert.rejects(client.call(echo, {}, { signal: controller.signal }), {
    code: ErrorCode.Cancelled,
  });
  controller.abort();
  await aborted;
  transport.window.dispatchEvent(new Event('pagehide'));
  restorePage(transport.window);
  const restored = client.ready();
  await setImmediate();
  const sid = 'restored-session';
  transport.push(frame({ id: transport.sent[3].rpc.id, result: {
    ...hello, sid, limits: { ...hello.limits, maxInflight: 1 },
  } }));
  await restored;

  const pending = client.call(echo);
  void pending.catch(() => {});
  assert.equal(transport.sent[4]?.rpc.method, echo);
  transport.receipts[0].resolve(null);
  await setImmediate();
  await assert.rejects(client.call(echo), { code: ErrorCode.NotReady });
  transport.push(frame({ id: transport.sent[4].rpc.id, result: true }, { sid }));
  assert.equal(await pending, true);
});

test('maxInflight reserves queueLimit for waiting calls once the session is ready', async (t) => {
  const transport = controlledTransport();
  const client = createBridge({ adapter: transport.adapter, queueLimit: 1 });
  const ready = client.ready();
  await setImmediate();
  connect(transport, { maxInflight: 1 });
  await ready;

  const controller = new AbortController();
  t.after(() => controller.abort());
  const options = { signal: controller.signal };
  const first = client.call(echo, {}, options);
  const waiting = client.call(echo, {}, options);
  const results = Promise.all([first, waiting]);
  void results.catch(() => {});
  assert.equal(transport.sent.length, 2);
  await assert.rejects(client.call(echo, {}, { ...options, timeout: 1000 }), { code: ErrorCode.NotReady });
  await assert.rejects(client.call(echo, {}, { ...options, version: 2 }), {
    code: ErrorCode.MethodNotFound, data: { reason: 'version_unsupported' },
  });
  assert.equal(transport.sent.length, 2);

  transport.push(frame({ id: transport.sent[1].rpc.id, result: 'first' }, { sid: hello.sid }));
  await setImmediate();
  assert.equal(transport.sent.length, 3);
  transport.push(frame({ id: transport.sent[2].rpc.id, result: 'waiting' }, { sid: hello.sid }));
  assert.deepEqual(await results, ['first', 'waiting']);
});

test('maxInflight admits each available slot when queueLimit is zero', async (t) => {
  const transport = controlledTransport();
  const client = createBridge({ adapter: transport.adapter, queueLimit: 0 });
  const ready = client.ready();
  await setImmediate();
  connect(transport, { maxInflight: 2 });
  await ready;

  const controller = new AbortController();
  t.after(() => controller.abort());
  const options = { signal: controller.signal };
  const first = client.call(echo, {}, options);
  const second = client.call(echo, {}, options);
  const results = Promise.all([first, second]);
  void results.catch(() => {});
  await setImmediate();
  assert.equal(transport.sent.length, 3);
  await assert.rejects(client.call(echo, {}, { ...options, timeout: 1000 }), { code: ErrorCode.NotReady });
  assert.equal(transport.sent.length, 3);

  transport.push(frame({ id: transport.sent[2].rpc.id, result: 'second' }, { sid: hello.sid }));
  transport.push(frame({ id: transport.sent[1].rpc.id, result: 'first' }, { sid: hello.sid }));
  assert.deepEqual(await results, ['first', 'second']);
});

test('maxInflight releases slots after both synchronous and asynchronous send failures', async (t) => {
  const transport = controlledTransport();
  let rejectSend;
  const client = createBridge({ adapter: {
    ...transport.adapter,
    send(raw) {
      transport.adapter.send(raw);
      const order = transport.sent.at(-1).rpc.params?.order;
      if (order === 1) throw new Error('Fixture synchronous send error');
      if (order === 2) return new Promise((_, reject) => { rejectSend = reject; });
    },
  } });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const options = { signal: controller.signal };
  const sync = assert.rejects(client.call(echo, { order: 1 }, options), { code: ErrorCode.Unavailable });
  const async = assert.rejects(client.call(echo, { order: 2 }, options), { code: ErrorCode.Unavailable });
  const final = client.call(echo, { order: 3 }, options);
  void Promise.all([sync, async, final]).catch(() => {});
  await setImmediate();
  connect(transport, { maxInflight: 1 });
  await client.ready();
  await sync;

  const sentOrders = () => transport.sent.slice(1).map(({ rpc }) => rpc.params.order);
  assert.deepEqual(sentOrders(), [1, 2]);
  rejectSend(new Error('Fixture asynchronous send error'));
  await async;
  await setImmediate();
  assert.deepEqual(sentOrders(), [1, 2, 3]);
  transport.push(frame({ id: transport.sent[3].rpc.id, result: 'third' }, { sid: hello.sid }));
  assert.equal(await final, 'third');
});

test('methods and explicit versions absent from capabilities fail locally', async () => {
  const transport = controlledTransport();
  const client = createBridge({ adapter: transport.adapter });
  const missing = assert.rejects(client.call('unknown.method'), {
    code: ErrorCode.MethodNotFound, method: 'unknown.method',
  });
  const wrongVersion = assert.rejects(client.call(echo, {}, { version: 2 }), {
    code: ErrorCode.MethodNotFound,
    data: { reason: 'version_unsupported' },
  });
  await setImmediate();
  connect(transport);
  await Promise.all([missing, wrongVersion]);
  assert.deepEqual(transport.sent.map(({ rpc }) => rpc.method), ['bridge.hello']);
});

test('an invalid JavaScript method argument leaves the connecting bridge usable', async () => {
  const client = createBridge({ adapter: createMockAdapter() });
  const [invalid, ready, valid] = await Promise.allSettled([
    client.call(null), client.ready(), client.call(echo, { ok: true }),
  ]);

  assert.equal(client.state, 'ready');
  assert.equal(client.has(null), false);
  assert.deepEqual(ready, { status: 'fulfilled', value: host });
  assert.deepEqual(valid, { status: 'fulfilled', value: { ok: true } });
  assert.equal(invalid.status, 'rejected');
  assert.ok(invalid.reason instanceof BridgeError);
  assert.equal(invalid.reason.code, ErrorCode.InvalidParams);
});

test('queued calls removed by timeout or abort produce no wire traffic after handshake', async () => {
  const transport = controlledTransport();
  const client = createBridge({ adapter: transport.adapter });
  const controller = new AbortController();
  const timedOut = assert.rejects(client.call(echo, {}, { timeout: 10 }), { code: ErrorCode.Timeout });
  const cancelled = assert.rejects(client.call(echo, {}, { signal: controller.signal }), {
    code: ErrorCode.Cancelled,
  });
  controller.abort();
  await Promise.all([timedOut, cancelled]);
  connect(transport);
  await client.ready();
  assert.deepEqual(transport.sent.map(({ rpc }) => rpc.method), ['bridge.hello']);
});

test('a queued call sends its remaining timeout and cancels its dispatched request once', async () => {
  const transport = controlledTransport();
  const client = createBridge({ adapter: transport.adapter });
  const controller = new AbortController();
  const pending = assert.rejects(client.call(echo, {}, { timeout: 1000, signal: controller.signal }), {
    code: ErrorCode.Cancelled,
  });
  await setTimeout(15);
  connect(transport);
  await client.ready();
  const request = transport.sent[1];
  assert.equal(request.rpc.method, echo);
  assert.equal(request.meta.sid, 'test-session');
  assert.ok(request.meta.timeout > 0 && request.meta.timeout < 1000);
  controller.abort();
  await pending;
  assert.deepEqual(transport.sent[2], {
    jsb: '1.0',
    meta: { sid: 'test-session' },
    rpc: { jsonrpc: '2.0', method: 'bridge.cancel', params: { requestId: request.rpc.id } },
  });
  assert.equal(transport.sent.length, 3);
});

test('a response arriving after its deadline triggers timeout even before the timer runs', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const transport = controlledTransport();
  const client = createBridge({ adapter: transport.adapter });
  const ready = client.ready();
  await setImmediate();
  connect(transport);
  await ready;

  const result = assert.rejects(client.call(echo, {}, { timeout: 1000 }), { code: ErrorCode.Timeout });
  const id = transport.sent[1].rpc.id;
  now = 1000;
  transport.push(frame({ id, result: 'too late' }, { sid: 'test-session' }));
  await result;
  assert.equal(transport.sent[2].rpc.method, 'bridge.cancel');
  assert.deepEqual(transport.sent[2].rpc.params, { requestId: id });
  assert.deepEqual(transport.sent[2].meta, { sid: 'test-session' });
});

test('only a correlated, session-matching response settles the call', async () => {
  const transport = controlledTransport();
  const client = createBridge({ adapter: transport.adapter });
  const ready = client.ready();
  await setImmediate();
  const helloId = transport.sent[0].rpc.id;
  transport.push(frame({ id: 'previous-hello', result: hello }, { sid: 'test-session' }));
  transport.push(frame({ id: helloId, result: hello }, { sid: 'different-session' }));
  assert.equal(client.state, 'connecting');
  connect(transport);
  await ready;

  const result = client.call(echo, { ok: true });
  await setImmediate();
  const id = transport.sent[1].rpc.id;
  transport.push(frame({ id: null, error: { code: -32600, message: 'Unmatched error' } }, { sid: 'test-session' }));
  transport.push(frame({ id, result: 'missing session' }));
  transport.push(frame({ id, result: 'old session' }, { sid: 'different-session' }));
  transport.push(frame({ id, result: 'first valid reply' }, { sid: 'test-session' }));
  transport.push(frame({ id, result: 'duplicate' }, { sid: 'test-session' }));
  assert.equal(await result, 'first valid reply');
});

test('an expired hello response cannot establish a session', async () => {
  const transport = controlledTransport();
  const client = createBridge({ adapter: transport.adapter, handshakeTimeout: 10 });
  await assert.rejects(client.ready(), { code: ErrorCode.Unavailable });
  connect(transport);
  assert.equal(client.state, 'unavailable');
  assert.equal(client.has(echo), false);
});

test('handshake protocol incompatibility is retained on ready and queued calls become unavailable', async () => {
  const transport = controlledTransport();
  const client = createBridge({ adapter: transport.adapter });
  const ready = assert.rejects(client.ready(), { code: ErrorCode.UnsupportedProtocol });
  const call = assert.rejects(client.call(echo), { code: ErrorCode.Unavailable });
  await setImmediate();
  transport.push(frame({
    id: transport.sent[0].rpc.id,
    error: { code: -32004, message: 'Unsupported protocol', data: { supported: [2] } },
  }));
  await Promise.all([ready, call]);
});

test('remote errors preserve their code and data as a BridgeError', async () => {
  const transport = controlledTransport();
  const client = createBridge({ adapter: transport.adapter });
  const result = assert.rejects(client.call(echo, {}, { traceId: '0123456789abcdef0123456789abcdef' }), (error) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, 1001);
    assert.equal(error.method, echo);
    assert.equal(error.traceId, '0123456789abcdef0123456789abcdef');
    assert.deepEqual(error.data, { reason: 'fixture' });
    return true;
  });
  await setImmediate();
  connect(transport);
  await client.ready();
  transport.push(frame({ id: transport.sent[1].rpc.id, error: {
    code: 1001, message: 'Fixture error', data: { reason: 'fixture' },
  } }, { sid: 'test-session' }));
  await result;
});

test('browser discovery accepts a shim installed after ready starts', async (t) => {
  const { window } = shimWindow(t);
  const mock = createMockAdapter();
  const client = createBridge({ handshakeTimeout: 500 });
  const ready = client.ready();
  window.__OJSB_TRANSPORT__ = { name: 'mock', protocols: [1], postMessage: (raw) => mock.send(raw) };
  window.dispatchEvent(new Event('ojsb:transportready'));
  assert.deepEqual(await ready, host);
  assert.deepEqual(await client.call(echo, { shim: true }), { shim: true });
});

test('the browser shim works when AbortSignal lacks throwIfAborted', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'throwIfAborted');
  Object.defineProperty(AbortSignal.prototype, 'throwIfAborted', { value: undefined, configurable: true });
  t.after(() => {
    if (descriptor) Object.defineProperty(AbortSignal.prototype, 'throwIfAborted', descriptor);
    else delete AbortSignal.prototype.throwIfAborted;
  });
  const mock = createMockAdapter();
  shimWindow(t, { name: 'mock', protocols: [1], postMessage: (raw) => mock.send(raw) });
  const client = createBridge();
  assert.deepEqual(await client.call(echo, { oldWebKit: true }), { oldWebKit: true });
});

test('a second client cannot take over the live shim receiver', async (t) => {
  const sent = [];
  const shim = shimWindow(t, { name: 'mock', protocols: [1], postMessage(raw) { sent.push(JSON.parse(raw)); } });
  const first = createBridge({ handshakeTimeout: 250 });
  const ready = first.ready();
  await setImmediate();
  shim.window.__OJSB_RECEIVE__(frame({ id: sent[0].rpc.id, result: hello }));
  await ready;

  const pending = first.call(echo, {}, { timeout: 500 });
  void pending.catch(() => {});
  const receiver = shim.receiver;
  const second = createBridge({ handshakeTimeout: 20 });
  await assert.rejects(second.ready(), { code: ErrorCode.Unavailable });
  assert.equal(shim.receiver, receiver);
  assert.equal(sent.length, 2);
  shim.window.__OJSB_RECEIVE__(frame({ id: sent[1].rpc.id, result: 'original call' }, { sid: hello.sid }));
  assert.equal(await pending, 'original call');
});

test('incompatible browser shim protocols fail before either receiver binding or hello send', async (t) => {
  let sends = 0;
  const shim = shimWindow(t, { name: 'mock', protocols: [2], postMessage() { sends++; } });
  const client = createBridge({ handshakeTimeout: 20 });
  await assert.rejects(client.ready(), { code: ErrorCode.UnsupportedProtocol, data: { supported: [2] } });
  assert.equal(sends, 0);
  assert.equal(shim.receiver, undefined);
});

test('pagehide retires the receiver and pending calls, then bfcache restore negotiates again', async (t) => {
  const sent = [];
  const shim = shimWindow(t, {
    name: 'mock', protocols: [1],
    postMessage(raw) {
      return new Promise((resolve) => sent.push({ rpc: JSON.parse(raw).rpc, resolve }));
    },
  });
  const client = createBridge({ handshakeTimeout: 200 });
  const before = client.ready();
  await setImmediate();
  sent[0].resolve(frame({ id: sent[0].rpc.id, result: {
    ...hello, limits: { ...hello.limits, maxInflight: 1 },
  } }));
  await before;
  const pending = assert.rejects(client.call(echo), { code: ErrorCode.Cancelled });
  const queued = assert.rejects(client.call(echo), { code: ErrorCode.Cancelled });

  shim.window.dispatchEvent(new Event('pagehide'));
  await Promise.all([pending, queued]);
  assert.equal(shim.receiver, undefined);
  assert.equal(client.has(echo), false);
  assert.equal(sent.length, 2);

  restorePage(shim.window);
  assert.equal(client.state, 'connecting');
  const after = client.ready();
  await setImmediate();
  assert.equal(sent[2].rpc.method, 'bridge.hello');
  assert.notEqual(sent[2].rpc.id, sent[0].rpc.id);
  sent[1].resolve(frame({ id: sent[1].rpc.id, result: 'old request' }, { sid: hello.sid }));
  shim.window.__OJSB_RECEIVE__(frame({ id: sent[0].rpc.id, result: hello }));
  assert.equal(client.state, 'connecting');

  const sid = 'restored-session';
  sent[2].resolve(frame({ id: sent[2].rpc.id, result: { ...hello, sid } }));
  await after;
  const call = client.call(echo);
  const id = sent[3].rpc.id;
  shim.window.__OJSB_RECEIVE__(frame({ id, result: 'old session' }, { sid: hello.sid }));
  shim.window.__OJSB_RECEIVE__(frame({ id, result: 'restored session' }, { sid }));
  assert.equal(await call, 'restored session');
});

test('pagehide cancels a bootstrap response that arrived but has not installed its session', async (t) => {
  const sent = [];
  const shim = shimWindow(t, { name: 'mock', protocols: [1], postMessage(raw) { sent.push(JSON.parse(raw)); } });
  const client = createBridge({ handshakeTimeout: 200 });
  const before = assert.rejects(client.ready(), { code: ErrorCode.Cancelled });
  await setImmediate();
  shim.window.__OJSB_RECEIVE__(frame({ id: sent[0].rpc.id, result: hello }));
  shim.window.dispatchEvent(new Event('pagehide'));
  restorePage(shim.window);
  const after = client.ready();
  await before;
  assert.equal(client.has(echo), false);
  assert.equal(client.state, 'connecting');
  await setImmediate();
  assert.notEqual(sent[0].rpc.id, sent[1].rpc.id);
  shim.window.__OJSB_RECEIVE__(frame({ id: sent[1].rpc.id, result: { ...hello, sid: 'fresh-session' } }));
  await after;
  assert.equal(client.has(echo), true);
});

test('request size preflight enforces the negotiated UTF-8 byte limit', async () => {
  const transport = controlledTransport();
  const client = createBridge({ adapter: transport.adapter });
  const ready = client.ready();
  await setImmediate();
  transport.push(frame({ id: transport.sent[0].rpc.id, result: {
    ...hello, limits: { ...hello.limits, maxMessageBytes: 350 },
  } }));
  await ready;
  await assert.rejects(client.call(echo, { text: '你'.repeat(100) }), { code: ErrorCode.PayloadTooLarge });
  assert.equal(transport.sent.length, 1);
});

test('an oversized UTF-8 reply cannot settle a call on either reply channel', async () => {
  const transport = controlledTransport();
  const maxMessageBytes = 350;
  let reply;
  const client = createBridge({ adapter: {
    ...transport.adapter,
    send(raw) {
      transport.adapter.send(raw);
      if (transport.sent.at(-1).rpc.method === echo) {
        return new Promise((resolve) => { reply = resolve; });
      }
    },
  } });
  const ready = client.ready();
  await setImmediate();
  transport.push(frame({ id: transport.sent[0].rpc.id, result: {
    ...hello, limits: { ...hello.limits, maxMessageBytes },
  } }));
  await ready;

  const result = client.call(echo, { ok: true });
  const id = transport.sent[1].rpc.id;
  const meta = { sid: hello.sid };
  const oversized = frame({ id, result: { text: '你'.repeat(100) } }, meta);
  assert.ok(oversized.length <= maxMessageBytes);
  assert.ok(Buffer.byteLength(oversized) > maxMessageBytes);
  reply(oversized);
  await setImmediate();
  transport.push(oversized);
  transport.push(frame({ id, result: { ok: true } }, meta));
  assert.deepEqual(await result, { ok: true });
});

test('the M1 client rejects a zero call timeout locally', async () => {
  const transport = controlledTransport();
  const client = createBridge({ adapter: transport.adapter });
  const ready = client.ready();
  await setImmediate();
  connect(transport);
  await ready;
  await assert.rejects(client.call(echo, {}, { timeout: 0 }), { code: ErrorCode.InvalidParams });
  assert.equal(transport.sent.length, 1);
});

test('Mock requires a negotiated session and handles repeated requests without repeating work', async () => {
  const adapter = createMockAdapter();
  const request = (id, method, params, meta) => adapter.send(frame({ id, method, params }, meta));
  assert.equal(await request('first', echo), null);
  const unsupported = JSON.parse(await request('hello-0', 'bridge.hello', { protocols: [2] }));
  assert.equal(unsupported.rpc.error.code, ErrorCode.UnsupportedProtocol);
  const invalid = JSON.parse(await request('hello-invalid', 'bridge.hello', { protocols: [1, 1] }));
  assert.equal(invalid.rpc.error.code, ErrorCode.InvalidParams);
  const first = JSON.parse(await request('hello-1', 'bridge.hello', { protocols: [1] }));
  assert.equal(await request('hello-1', 'bridge.hello', { protocols: [1] }), null);
  const second = JSON.parse(await request('hello-2', 'bridge.hello', { protocols: [1] }));
  assert.ok(first.rpc.result.sid);
  assert.equal(first.rpc.result.sid, second.rpc.result.sid);
  assert.equal(await request('first', echo, {}, { sid: 'old-session' }), null);
  const meta = { sid: first.rpc.result.sid };
  assert.deepEqual(JSON.parse(await request('first', echo, { answer: 42 }, meta)).rpc.result, { answer: 42 });
  assert.equal(await request('first', echo, { answer: 999 }, meta), null);
  assert.equal(await adapter.send(frame({ method: 'bridge.cancel', params: { requestId: 'first' } }, meta)), null);
});

test('Mock replies to malformed JSON only on its established route and ignores responses', async () => {
  const adapter = createMockAdapter();
  assert.equal(await adapter.send('{'), null);
  const negotiated = JSON.parse(await adapter.send(frame({
    id: 'hello', method: 'bridge.hello', params: { protocols: [1] },
  })));
  const response = JSON.parse(await adapter.send('{'));
  assert.equal(response.meta.sid, negotiated.rpc.result.sid);
  assert.equal(response.rpc.id, null);
  assert.equal(response.rpc.error.code, ErrorCode.ParseError);
  assert.equal(await adapter.send(frame({ id: 'host-request', result: true }, response.meta)), null);
});
