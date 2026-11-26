import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';

const readMethod = (name) => JSON.parse(readFileSync(
  new URL(`../spec/methods/bridge/${name}.json`, import.meta.url), 'utf8',
));
const ajv = new Ajv2020({ strictRequired: true });

test('subscription schemas accept qualified event lists and require explicit acknowledgements', () => {
  const subscribe = readMethod('subscribe');
  const unsubscribe = readMethod('unsubscribe');

  for (const schema of [subscribe, unsubscribe]) {
    const params = ajv.compile(schema.params);
    assert.equal(params({ events: ['network.statusChanged', 'acme.pay.orderChanged'] }), true);
    assert.equal(params({ events: [] }), false);
    assert.equal(params({ events: ['network.statusChanged', 'network.statusChanged'] }), false);
    assert.equal(params({ events: ['changed'] }), false);
    assert.equal(params({ events: ['network.statusChanged@1'] }), false);
    assert.equal(params({ events: ['rpc.changed'] }), false);
  }

  const subscribed = ajv.compile(subscribe.result);
  assert.equal(subscribed({ subscribed: ['network.statusChanged'], denied: ['acme.pay.orderChanged'] }), true);
  assert.equal(subscribed({ subscribed: [] }), false);

  const unsubscribed = ajv.compile(unsubscribe.result);
  assert.equal(unsubscribed({ unsubscribed: ['network.statusChanged'] }), true);
  assert.equal(unsubscribed({}), false);
});

test('the default bridge handshakes and follows subscriptions through an injected Mock', { timeout: 2_000 }, async (t) => {
  const target = new EventTarget();
  const needsCustomEvent = typeof CustomEvent === 'undefined';
  if (needsCustomEvent) globalThis.CustomEvent = class CustomEvent extends Event {};
  Object.defineProperty(globalThis, 'window', { value: target, configurable: true });
  t.after(() => {
    delete globalThis.window;
    if (needsCustomEvent) delete globalThis.CustomEvent;
  });

  const { bridge } = await import('../dist/packages/web-sdk/src/auto.js');
  const { ErrorCode } = await import('../dist/packages/web-sdk/src/index.js');
  const { installMockTransport } = await import('../dist/packages/web-mock/src/index.js');
  const name = 'network.statusChanged';
  const denied = 'demo.restricted';
  let reportUnsubscribe;
  const unsubscribed = new Promise((resolve) => { reportUnsubscribe = resolve; });
  const mock = installMockTransport({
    events: [name],
    deniedEvents: [denied],
    onFrame(direction, raw) {
      if (direction === 'response' && raw !== null) {
        const events = JSON.parse(raw).rpc.result?.unsubscribed;
        if (events) reportUnsubscribe(events);
      }
    },
  });

  const payloads = [];
  const off = bridge.on(name, (payload) => { payloads.push(payload); });
  assert.equal(mock.emit(name, { type: 'early' }), false);
  await off.ready;
  assert.equal(bridge.hasEvent(name), true);
  assert.equal(bridge.hasEvent('network.changed'), false);
  const obsolete = bridge.on('network.changed', () => assert.fail('the retired event was delivered'));
  await assert.rejects(obsolete.ready, { code: ErrorCode.MethodNotFound });
  assert.equal(mock.emit('network.changed', { type: 'wifi' }), false);
  assert.equal(mock.emit(name, { type: 'wifi' }), true);

  const offDenied = bridge.on(denied, () => { assert.fail('a denied event reached Web'); });
  await assert.rejects(offDenied.ready, { code: ErrorCode.PermissionDenied });
  offDenied();
  assert.equal(mock.emit(denied, { value: true }), false);

  off();
  assert.deepEqual(await unsubscribed, [name]);
  assert.equal(mock.emit(name, { type: 'cellular' }), false);
  assert.deepEqual(payloads, [{ type: 'wifi' }]);
});

test('the standard event schemas define two lifecycle events and the shared network status', () => {
  const spec = (path) => JSON.parse(readFileSync(new URL(`../spec/${path}.json`, import.meta.url), 'utf8'));
  const validator = new Ajv2020();
  validator.addSchema(spec('schemas/network-status'));
  const change = spec('methods/network/statusChanged');
  assert.equal(change.title, 'network.statusChanged');
  assert.deepEqual(change.payload, spec('methods/network/getStatus').result);
  assert.equal(validator.compile(change.payload)({ type: 'wifi' }), true);
  for (const name of ['foregrounded', 'backgrounded']) {
    const event = spec(`methods/app/${name}`);
    const validate = validator.compile(event.payload);
    assert.equal(event.title, `app.${name}`);
    assert.equal(validate(null), true);
    assert.equal(validate({}), false);
  }
  assert.throws(() => spec('methods/network/changed'), { code: 'ENOENT' });
});
