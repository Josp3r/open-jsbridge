import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { BridgeError, createBridge, ErrorCode } from '../dist/packages/web-sdk/src/index.js';

const name = 'network.changed';
const subscribed = { subscribed: [name], denied: [] };
const unsubscribed = { unsubscribed: [name] };

function frame(rpc, sid) {
  return JSON.stringify({ jsb: '1.0', ...(sid === undefined ? {} : { meta: { sid } }), rpc: { jsonrpc: '2.0', ...rpc } });
}

function event(payload, sid = 'first', eventName = name) {
  return frame({ method: 'bridge.event', params: { name: eventName, payload } }, sid);
}

function fixture(defaultTimeoutMs = 15_000, { maxInflight = 64, onSend, queueLimit } = {}) {
  const sent = [];
  const routes = [];
  let route;
  const client = createBridge({
    queueLimit,
    adapter: {
      send(raw) {
        return new Promise((reply) => {
          const request = { ...JSON.parse(raw), reply };
          sent.push(request);
          onSend?.(request, route);
        });
      },
      listen(receive) {
        routes.push(receive);
        route = receive;
        return () => { route = undefined; };
      },
    },
  });
  const push = (raw) => route?.(raw);
  const reply = (request, result, sid = 'first') => {
    assert.ok(request, 'Expected an outbound request for this response');
    push(frame({ id: request.rpc.id, result }, sid));
  };
  const hello = async (sid = 'first', capabilities = { events: [name], features: [] }) => {
    await setImmediate();
    const request = sent.findLast(({ rpc }) => rpc.method === 'bridge.hello');
    assert.ok(request.rpc.params.wants.includes('events'));
    reply(request, {
      jsb: '1.0', sid, host: { platform: 'fixture', name: 'fixture', version: '1' },
      capabilities: { methods: {}, ...capabilities },
      limits: { maxMessageBytes: 1_048_576, maxInflight, defaultTimeoutMs },
    }, sid);
    await client.ready();
  };
  return { client, sent, routes, push, reply, hello };
}

test('event controls share the negotiated slot and process the acknowledgement before sending again', async (t) => {
  const window = new EventTarget();
  Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
  t.after(() => {
    window.dispatchEvent(new Event('pagehide'));
    delete globalThis.window;
  });

  const method = 'acme.app.getConfig';
  const { client, sent, hello, reply, push } = fixture(15_000, {
    maxInflight: 1,
    onSend(request, receive) {
      if (request.rpc.params?.afterSubscription) receive(event('during the next send'));
    },
  });
  void client.ready();
  await hello('first', { events: [name], features: [], methods: { [method]: { versions: [1] } } });
  const first = client.call(method);
  const seen = [];
  const stop = client.on(name, (payload) => seen.push(payload));
  const next = client.call(method, { afterSubscription: true });
  void first.catch(() => {});
  void next.catch(() => {});

  assert.deepEqual(sent.map(({ rpc }) => rpc.method), ['bridge.hello', method]);
  reply(sent[1], {});
  assert.deepEqual(sent.map(({ rpc }) => rpc.method), ['bridge.hello', method, 'bridge.subscribe']);
  push(event('before acknowledgement'));
  assert.deepEqual(seen, []);

  reply(sent[2], subscribed);
  assert.deepEqual(sent.map(({ rpc }) => rpc.method), ['bridge.hello', method, 'bridge.subscribe', method]);
  assert.deepEqual(seen, ['during the next send']);
  reply(sent[3], {});
  await Promise.all([first, stop.ready, next]);
});

test('a subscribe that times out while queued does not send an unsubscribe', async (t) => {
  const window = new EventTarget();
  Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
  t.after(() => {
    window.dispatchEvent(new Event('pagehide'));
    delete globalThis.window;
  });

  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const method = 'acme.app.getConfig';
  const { client, sent, hello, reply } = fixture(5, { maxInflight: 1 });
  void client.ready();
  await hello('first', { events: [name], features: [], methods: { [method]: { versions: [1] } } });
  const first = client.call(method, {}, { timeout: 1000 });
  void first.catch(() => {});
  const stop = client.on(name, () => {});
  now = 5;
  await assert.rejects(stop.ready, { code: ErrorCode.Timeout });

  reply(sent[1], {});
  await first;
  assert.deepEqual(sent.map(({ rpc }) => rpc.method), ['bridge.hello', method]);
});

test('the last listener unsubscribes after a busy slot even with zero waiting capacity', async (t) => {
  const window = new EventTarget();
  Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
  t.after(() => {
    window.dispatchEvent(new Event('pagehide'));
    delete globalThis.window;
  });

  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const method = 'acme.app.getConfig';
  const { client, sent, hello, reply, push } = fixture(5, { maxInflight: 1, queueLimit: 0 });
  void client.ready();
  await hello('first', { events: [name], features: [], methods: { [method]: { versions: [1] } } });
  const seen = [];
  const stop = client.on(name, (payload) => seen.push(payload));
  reply(sent[1], subscribed);
  await stop.ready;
  const first = client.call(method, {}, { timeout: 1000 });
  void first.catch(() => {});
  stop();
  now = 10;
  await assert.rejects(client.call(method), { code: ErrorCode.NotReady });
  push(event('after removing listener'));
  assert.deepEqual(seen, []);
  assert.deepEqual(sent.map(({ rpc }) => rpc.method), ['bridge.hello', 'bridge.subscribe', method]);

  reply(sent[2], {});
  await first;
  assert.equal(sent[3]?.rpc.method, 'bridge.unsubscribe');
  assert.equal(sent[3].meta.timeout, 5);
  reply(sent[3], unsubscribed);
});

test('one acknowledged remote subscription fans out to listeners until the last one is removed', async () => {
  const { client, sent, push, reply, hello } = fixture();
  const first = [];
  const second = [];
  const listener = (payload) => first.push(payload);
  assert.equal(client.hasEvent(name), false);
  const stop = client.on(name, listener);
  const stopOther = client.on(name, (payload) => second.push(payload));
  assert.equal(client.on(name, listener), stop);
  let acknowledged = false;
  void stop.ready.then(() => { acknowledged = true; }, () => {});

  await hello();
  assert.equal(client.hasEvent(name), true);
  assert.equal(client.hasEvent('network.other'), false);
  assert.equal(client.has('bridge.subscribe'), false);
  await assert.rejects(client.call('bridge.subscribe', { events: [name] }), { code: ErrorCode.MethodNotFound });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].rpc.method, 'bridge.subscribe');
  assert.deepEqual(sent[1].rpc.params, { events: [name] });
  assert.equal(sent[1].meta.sid, 'first');
  assert.equal(acknowledged, false);
  push(event('before ack'));
  reply(sent[1], subscribed);
  push(event(null));
  await Promise.all([stop.ready, stopOther.ready]);
  assert.deepEqual(first, [null]);
  assert.deepEqual(second, [null]);

  client.off(name, listener);
  stop();
  push(event([true, 'wifi']));
  assert.deepEqual(first, [null]);
  assert.deepEqual(second, [null, [true, 'wifi']]);
  assert.equal(sent.length, 2);
  client.off(name);
  push(event('after off'));
  assert.deepEqual(second, [null, [true, 'wifi']]);
  assert.equal(sent.length, 3);
  assert.equal(sent[2].rpc.method, 'bridge.unsubscribe');
  assert.deepEqual(sent[2].rpc.params, { events: [name] });
  reply(sent[2], unsubscribed);
  stopOther();
  assert.equal(sent.length, 3);
});

test('denied and malformed acknowledgements reject ready without enabling delivery', async () => {
  const { client, sent, push, reply, hello } = fixture();
  const seen = [];
  const listener = (payload) => seen.push(payload);
  const denied = client.on(name, listener);
  await hello();
  reply(sent[1], { subscribed: [], denied: [name] });
  await setImmediate();
  await assert.rejects(denied.ready, { name: 'BridgeError', code: ErrorCode.PermissionDenied });
  push(event('denied'));

  for (const result of [
    { subscribed: [name], denied: [name] },
    { subscribed: [name], denied: ['network.other'] },
    { subscribed: [], denied: [] },
    { subscribed: [name] },
  ]) {
    const malformed = client.on(name, listener);
    reply(sent.at(-1), result);
    await assert.rejects(malformed.ready, { code: ErrorCode.InvalidRequest });
    push(event('malformed'));
    const cleanup = sent.at(-1);
    assert.equal(cleanup.rpc.method, 'bridge.unsubscribe');
    reply(cleanup, unsubscribed);
  }
  assert.deepEqual(seen, []);

  const accepted = client.on(name, listener);
  reply(sent.at(-1), subscribed);
  await accepted.ready;
  denied();
  push(event('accepted'));
  assert.deepEqual(seen, ['accepted']);
});

test('events require advertised capability without a business method entry', async () => {
  for (const capabilities of [
    { events: ['network.other'], features: ['events'] },
    { events: [], features: [] },
  ]) {
    const { client, sent, hello } = fixture();
    const stop = client.on(name, () => {});
    await hello('first', capabilities);
    await assert.rejects(stop.ready, (error) => error instanceof BridgeError && error.code === ErrorCode.MethodNotFound);
    assert.equal(client.hasEvent(name), false);
    assert.equal(sent.length, 1);
  }
});

test('event delivery ignores request shapes, malformed params, other names, stale sessions and direct replies', async () => {
  const { client, sent, push, reply, hello } = fixture();
  const seen = [];
  const stop = client.on(name, (payload) => seen.push(payload));
  await hello();
  reply(sent[1], subscribed);
  await stop.ready;

  for (const raw of [
    frame({ id: 'native-request', method: 'bridge.event', params: { name, payload: 'request' } }, 'first'),
    frame({ method: 'bridge.event@1', params: { name, payload: 'wrong method' } }, 'first'),
    frame({ method: 'bridge.event', params: { name } }, 'first'),
    frame({ method: 'bridge.event', params: { name: false, payload: 'bad name' } }, 'first'),
    frame({ method: 'bridge.event', params: { name, payload: 'missing sid' } }),
    event('old session', 'old'),
    event('unsubscribed', 'first', 'network.other'),
  ]) push(raw);
  sent[1].reply(event('direct reply'));
  await setImmediate();
  assert.deepEqual(seen, []);
  push(event({ type: 'wifi' }));
  assert.deepEqual(seen, [{ type: 'wifi' }]);
  assert.equal(sent.length, 2);
});

test('unsubscribe completes before resubscribe and stale acknowledgements cannot revive delivery', async () => {
  const { client, sent, push, reply, hello } = fixture();
  const seen = [];
  const listener = (payload) => seen.push(payload);
  const first = client.on(name, listener);
  await hello();
  const initial = sent[1];

  first();
  await assert.rejects(first.ready, { code: ErrorCode.Cancelled });
  reply(initial, subscribed);
  await setImmediate();
  const cleanup = sent[2];
  assert.equal(cleanup.rpc.method, 'bridge.unsubscribe');

  const next = client.on(name, listener);
  first();
  assert.equal(sent.length, 3);
  reply(initial, subscribed);
  push(event('stale'));
  assert.deepEqual(seen, []);
  reply(cleanup, unsubscribed);
  await setImmediate();
  assert.equal(sent.length, 4);
  assert.equal(sent[3].rpc.method, 'bridge.subscribe');
  reply(sent[3], subscribed);
  await next.ready;
  push(event('current'));
  assert.deepEqual(seen, ['current']);
});

test('quick off/on while subscribe is pending can share its acknowledgement', async () => {
  const { client, sent, push, reply, hello } = fixture();
  const seen = [];
  const one = client.on(name, (payload) => seen.push(['old', payload]));
  await hello();
  one();
  const two = client.on(name, (payload) => seen.push(['new', payload]));
  assert.equal(sent.length, 2);
  reply(sent[1], subscribed);
  await assert.rejects(one.ready, { code: ErrorCode.Cancelled });
  await two.ready;
  push(event('current'));
  assert.deepEqual(seen, [['new', 'current']]);
  assert.equal(sent.length, 2);
});

test('a timed-out subscribe acknowledgement cannot settle or activate a later registration', async () => {
  const { client, sent, push, reply, hello } = fixture(25);
  const seen = [];
  const listener = (payload) => seen.push(payload);
  const initial = client.on(name, listener);
  await hello();
  const original = sent[1];
  await assert.rejects(initial.ready, { code: ErrorCode.Timeout });

  const cleanup = sent[2];
  assert.equal(cleanup.rpc.method, 'bridge.unsubscribe');
  const retry = client.on(name, listener);
  assert.equal(sent.length, 3);
  reply(original, subscribed);
  push(event('late ack'));
  reply(cleanup, unsubscribed);
  const current = sent[3];
  assert.notEqual(current.rpc.id, original.rpc.id);
  assert.equal(current.rpc.method, 'bridge.subscribe');
  reply(current, subscribed);
  await retry.ready;
  push(event('current'));
  assert.deepEqual(seen, ['current']);
});

test('unconfirmed unsubscribe rejects registrations waiting for it to complete', async () => {
  for (const [outcome, code] of [
    [{ result: { unsubscribed: [] } }, ErrorCode.InvalidRequest],
    [{ result: { unsubscribed: ['network.other'] } }, ErrorCode.InvalidRequest],
    [{ result: { unsubscribed: [name, 'network.other'] } }, ErrorCode.InvalidRequest],
    [{ error: { code: ErrorCode.PermissionDenied, message: 'Denied' } }, ErrorCode.PermissionDenied],
  ]) {
    const { client, sent, push, reply, hello } = fixture();
    const seen = [];
    const listener = (payload) => seen.push(payload);
    const initial = client.on(name, listener);
    await hello();
    reply(sent[1], subscribed);
    await initial.ready;
    initial();
    const next = client.on(name, listener);
    assert.equal(sent.length, 3);
    push(frame({ id: sent[2].rpc.id, ...outcome }, 'first'));
    await assert.rejects(next.ready, { code, method: 'bridge.unsubscribe' });
    push(event('uncertain'));
    assert.equal(sent.length, 3);
    assert.deepEqual(seen, []);
  }
});

test('bfcache restoration resubscribes the same listeners and ignores retired routes and sessions', async (t) => {
  const window = new EventTarget();
  Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
  t.after(() => { delete globalThis.window; });
  const { client, sent, routes, push, reply, hello } = fixture();
  const seen = [];
  const stop = client.on(name, (payload) => seen.push(payload));
  await hello();
  reply(sent[1], subscribed);
  await stop.ready;
  push(event('first'));

  window.dispatchEvent(new Event('pagehide'));
  assert.equal(client.hasEvent(name), false);
  const restored = new Event('pageshow');
  Object.defineProperty(restored, 'persisted', { value: true });
  window.dispatchEvent(restored);
  await hello('restored');
  assert.equal(client.hasEvent(name), true);
  assert.deepEqual(sent.map(({ rpc }) => rpc.method), [
    'bridge.hello', 'bridge.subscribe', 'bridge.hello', 'bridge.subscribe',
  ]);
  reply(sent[1], subscribed, 'restored');
  push(event('before re-ack', 'restored'));
  reply(sent[3], subscribed, 'restored');
  routes[0](event('retired route', 'restored'));
  push(event('retired session'));
  push(event('restored', 'restored'));
  assert.deepEqual(seen, ['first', 'restored']);
  stop();
  reply(sent.at(-1), unsubscribed, 'restored');
});

test('bfcache restoration serializes acknowledged subscriptions with zero waiting capacity', async (t) => {
  const window = new EventTarget();
  Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
  t.after(() => {
    window.dispatchEvent(new Event('pagehide'));
    delete globalThis.window;
  });
  const second = 'app.foreground';
  const capabilities = { events: [name, second], features: [] };
  const { client, sent, push, reply, hello } = fixture(15_000, { maxInflight: 1, queueLimit: 0 });
  void client.ready();
  await hello('first', capabilities);
  const seen = [];
  const firstStop = client.on(name, (payload) => seen.push(payload));
  reply(sent[1], subscribed);
  await firstStop.ready;
  const secondStop = client.on(second, (payload) => seen.push(payload));
  const secondAck = { subscribed: [second], denied: [] };
  reply(sent[2], secondAck);
  await secondStop.ready;

  window.dispatchEvent(new Event('pagehide'));
  const restored = new Event('pageshow');
  Object.defineProperty(restored, 'persisted', { value: true });
  window.dispatchEvent(restored);
  await hello('restored', capabilities);
  assert.equal(sent.length, 5);
  assert.deepEqual(sent[4].rpc.params.events, [name]);
  reply(sent[4], subscribed, 'restored');
  assert.deepEqual(sent[5]?.rpc.params.events, [second]);
  reply(sent[5], secondAck, 'restored');
  push(event('first', 'restored'));
  push(event('second', 'restored', second));
  assert.deepEqual(seen, ['first', 'second']);
});

test('a failed bfcache resubscribe cleans up without retrying established listeners in a loop', async (t) => {
  const window = new EventTarget();
  Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
  t.after(() => { delete globalThis.window; });
  const { client, sent, push, reply, hello } = fixture();
  const seen = [];
  const stop = client.on(name, (payload) => seen.push(payload));
  await hello();
  reply(sent[1], subscribed);
  await stop.ready;

  window.dispatchEvent(new Event('pagehide'));
  const restored = new Event('pageshow');
  Object.defineProperty(restored, 'persisted', { value: true });
  window.dispatchEvent(restored);
  await hello('restored');
  reply(sent[3], { subscribed: [name], denied: [name] }, 'restored');
  assert.equal(sent[4].rpc.method, 'bridge.unsubscribe');
  reply(sent[4], unsubscribed, 'restored');
  push(event('uncertain', 'restored'));
  assert.equal(sent.length, 5);
  assert.deepEqual(seen, []);
  stop();
});

test('a listener awaiting its first acknowledgement survives a bfcache round trip', async (t) => {
  const window = new EventTarget();
  Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
  t.after(() => { delete globalThis.window; });
  const { client, sent, routes, push, reply, hello } = fixture();
  const seen = [];
  const stop = client.on(name, (payload) => seen.push(payload));
  await hello();
  const first = sent[1];

  window.dispatchEvent(new Event('pagehide'));
  const restored = new Event('pageshow');
  Object.defineProperty(restored, 'persisted', { value: true });
  window.dispatchEvent(restored);
  await hello('restored');

  routes[0](frame({ id: first.rpc.id, result: subscribed }, 'first'));
  reply(first, subscribed, 'restored');
  push(event('early', 'restored'));
  reply(sent[3], subscribed, 'restored');
  await stop.ready;
  push(event('restored', 'restored'));
  assert.deepEqual(seen, ['restored']);
});
