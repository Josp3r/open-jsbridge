import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ErrorCode } from '../dist/packages/protocol/src/index.js';
import { createMockAdapter, installMockTransport } from '../dist/packages/web-mock/src/index.js';

const eventName = 'network.statusChanged';
const deniedName = 'app.backgrounded';
const unknownName = 'app.foregrounded';

function request(id, method, params, sid) {
  return JSON.stringify({
    jsb: '1.0',
    ...(sid === undefined ? {} : { meta: { sid } }),
    rpc: { jsonrpc: '2.0', id, method, params },
  });
}

async function hello(send) {
  const { rpc } = JSON.parse(await send(request('hello', 'bridge.hello', { protocols: [1] })));
  return rpc.result;
}

test('Mock advertises the configured event names once and defaults to no events', async () => {
  const defaultHost = await hello(createMockAdapter().send);
  assert.deepEqual(defaultHost.capabilities.events, []);

  const configuredHost = await hello(createMockAdapter({
    events: [eventName, eventName, 'changed', 'network.statusChanged@1', 'rpc.changed'],
    deniedEvents: [deniedName],
  }).send);
  assert.deepEqual(configuredHost.capabilities.events, [eventName, deniedName]);
});

test('Mock sends notifications only for allowed subscriptions on its current route', async () => {
  const adapter = createMockAdapter({ events: [eventName], deniedEvents: [deniedName] });
  const frames = [];
  const unlisten = adapter.listen((raw) => frames.push(JSON.parse(raw)));
  assert.equal(adapter.emit(eventName, true), false);

  const { sid } = await hello(adapter.send);
  const subscription = (id, events, session = sid) =>
    adapter.send(request(id, 'bridge.subscribe', { events }, session));

  assert.equal(await subscription('wrong-route', [eventName], 'old-session'), null);
  assert.equal(adapter.emit(eventName, true), false);

  const reply = JSON.parse(await subscription('subscribe', [eventName, deniedName, unknownName]));
  assert.deepEqual(reply.rpc.result, { subscribed: [eventName], denied: [deniedName, unknownName] });
  assert.deepEqual(frames, []);
  assert.equal(adapter.emit(deniedName, true), false);
  assert.equal(adapter.emit(unknownName, true), false);

  const payload = [null, { type: 'wifi' }];
  assert.equal(adapter.emit(eventName, payload), true);
  assert.deepEqual(frames, [{
    jsb: '1.0', meta: { sid },
    rpc: { jsonrpc: '2.0', method: 'bridge.event', params: { name: eventName, payload } },
  }]);

  unlisten();
  assert.equal(adapter.emit(eventName, true), false);
  const nextFrames = [];
  adapter.listen((raw) => nextFrames.push(raw));
  assert.equal(adapter.emit(eventName, true), false);
  assert.deepEqual(nextFrames, []);
});

test('Mock validates the full control request before updating subscriptions', async () => {
  const adapter = createMockAdapter({ events: [eventName] });
  const { sid } = await hello(adapter.send);
  const events = [eventName];
  const control = (id, method, params) => adapter.send(request(id, method, params, sid));

  for (const [index, params] of [{}, { events: [] }, { events: [eventName, true] },
      { events: [eventName, eventName] }, { events: [eventName, 'changed'] },
      { events: [eventName, 'network.statusChanged@1'] }].entries()) {
    const reply = JSON.parse(await control(`invalid-${index}`, 'bridge.subscribe', params));
    assert.equal(reply.rpc.error.code, ErrorCode.InvalidParams);
    assert.equal(reply.meta.sid, sid);
  }
  adapter.listen(() => {});
  assert.equal(adapter.emit(eventName, null), false);

  await control('subscribe', 'bridge.subscribe', { events });
  assert.equal(adapter.emit(eventName, null), true);
  const invalidUnsubscribe = JSON.parse(await control('invalid-unsubscribe', 'bridge.unsubscribe', { events: [eventName, null] }));
  assert.equal(invalidUnsubscribe.rpc.error.code, ErrorCode.InvalidParams);
  assert.equal(adapter.emit(eventName, null), true);

  const unsubscribe = { events: [eventName, unknownName] };
  for (const id of ['unsubscribe', 'unsubscribe-again']) {
    const reply = JSON.parse(await control(id, 'bridge.unsubscribe', unsubscribe));
    assert.deepEqual(reply.rpc.result, { unsubscribed: [eventName, unknownName] });
    assert.equal(adapter.emit(eventName, null), false);
  }
});

test('Mock drops invalid and oversized event payloads', async () => {
  const adapter = createMockAdapter({ events: [eventName] });
  const frames = [];
  adapter.listen((raw) => frames.push(raw));
  const { sid, limits } = await hello(adapter.send);
  await adapter.send(request('subscribe', 'bridge.subscribe', { events: [eventName] }, sid));

  const cyclic = {};
  cyclic.self = cyclic;
  for (const payload of [undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1,
      { invalid: undefined }, [() => {}], cyclic, 1n, '字'.repeat(limits.maxMessageBytes / 3)]) {
    assert.equal(adapter.emit(eventName, payload), false);
  }
  assert.deepEqual(frames, []);
  assert.equal(adapter.emit(eventName, null), true);
  assert.equal(JSON.parse(frames[0]).rpc.params.payload, null);
});

test('browser Mock emits through the receiver and observes outbound events', async (t) => {
  const target = new EventTarget();
  const needsCustomEvent = typeof CustomEvent === 'undefined';
  if (needsCustomEvent) globalThis.CustomEvent = class CustomEvent extends Event {};
  Object.defineProperty(globalThis, 'window', { value: target, configurable: true });
  t.after(() => {
    delete globalThis.window;
    if (needsCustomEvent) delete globalThis.CustomEvent;
  });
  const frames = [];
  const installed = installMockTransport({ events: [eventName], onFrame(direction, raw) {
    frames.push([direction, raw]);
  } });
  const { postMessage } = target.__OJSB_TRANSPORT__;
  const { sid } = await hello(postMessage);
  const reply = JSON.parse(await postMessage(request('subscribe', 'bridge.subscribe', { events: [eventName] }, sid)));
  assert.deepEqual(reply.rpc.result, { subscribed: [eventName], denied: [] });
  assert.equal(installMockTransport({ events: [unknownName] }), undefined);
  assert.equal(installed.emit(eventName, 'wifi'), false);

  const received = [];
  target.__OJSB_RECEIVE__ = (raw) => received.push(raw);
  assert.equal(installed.emit(eventName, 'wifi'), true);
  assert.deepEqual(frames.map(([direction]) => direction), ['request', 'response', 'request', 'response', 'event']);
  assert.deepEqual(received, [frames[4][1]]);
  assert.deepEqual(JSON.parse(received[0]).rpc, {
    jsonrpc: '2.0', method: 'bridge.event', params: { name: eventName, payload: 'wifi' },
  });

  target.dispatchEvent(new Event('pagehide'));
  assert.equal(installed.emit(eventName, 'stale'), false);
  const restored = await hello(postMessage);
  assert.notEqual(restored.sid, sid);
  assert.equal(await postMessage(request('stale', 'bridge.subscribe', { events: [eventName] }, sid)), null);
  assert.equal(installed.emit(eventName, 'cellular'), false);
  await postMessage(request('subscribe', 'bridge.subscribe', { events: [eventName] }, restored.sid));
  assert.equal(installed.emit(eventName, 'cellular'), true);
  assert.equal(JSON.parse(received[1]).meta.sid, restored.sid);
});
