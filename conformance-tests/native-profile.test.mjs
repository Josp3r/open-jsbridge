import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { createMockAdapter } from '../dist/packages/web-mock/src/index.js';

const ajv = new Ajv2020({ strictRequired: true });
const load = (path) => JSON.parse(readFileSync(new URL('../spec/' + path, import.meta.url), 'utf8'));

function exchange(adapter) {
  let sid;
  let count = 0;
  return async (method, params) => {
    const frame = {
      jsb: '1.0',
      ...(sid === undefined ? {} : { meta: { sid } }),
      rpc: { jsonrpc: '2.0', id: `native-profile-${++count}`, method, params },
    };
    const response = JSON.parse(await adapter.send(JSON.stringify(frame))).rpc;
    if (method === 'bridge.hello') sid = response.result.sid;
    return response;
  };
}

test('the two native modules advertise and dispatch methods independently', async () => {
  for (const [options, method, missing, expected] of [
    [{ deviceInfo: { os: 'ios', osVersion: '27.2' } }, 'device.getInfo', 'network.getStatus', { os: 'ios', osVersion: '27.2' }],
    [{ getNetworkStatus: () => ({ type: 'ethernet' }) }, 'network.getStatus', 'device.getInfo', { type: 'ethernet' }],
  ]) {
    const send = exchange(createMockAdapter(options));
    const { result: { capabilities } } = await send('bridge.hello', { protocols: [1] });
    assert.deepEqual(capabilities.methods[method], { versions: [1] });
    assert.equal(capabilities.methods[missing], undefined);
    assert.deepEqual(capabilities.events, []);
    assert.deepEqual((await send(method)).result, expected);
    assert.deepEqual((await send(method + '@1', {})).result, expected);
    assert.equal((await send(method + '@2')).error.code, -32601);
    assert.equal((await send(method, { extra: true })).error.code, -32602);
    assert.equal((await send(missing)).error.code, -32601);
  }
});

test('network snapshots follow the provider independently of event registration', async () => {
  let type = 'wifi';
  const send = exchange(createMockAdapter({ getNetworkStatus: () => ({ type }) }));
  await send('bridge.hello', { protocols: [1] });
  assert.deepEqual((await send('network.getStatus')).result, { type: 'wifi' });
  type = 'none';
  assert.deepEqual((await send('network.getStatus')).result, { type: 'none' });
});

test('native profile schemas share the same network statuses', () => {
  const device = load('methods/device/getInfo.json');
  const snapshot = load('methods/network/getStatus.json');
  const event = load('methods/network/changed.json');
  ajv.addSchema(load('schemas/network-status.json'));
  const queryResult = ajv.compile(snapshot.result);
  const eventPayload = ajv.compile(event.payload);
  for (const type of ['wifi', 'cellular', 'ethernet', 'other', 'none', 'unknown']) {
    assert.ok(queryResult({ type }));
    assert.ok(eventPayload({ type }));
  }
  assert.equal(eventPayload({ type: '5g' }), false);
  assert.equal(queryResult({ type: 'wifi', ssid: 'Private network' }), false);
  const deviceResult = ajv.compile(device.result);
  assert.ok(deviceResult({ os: 'android', osVersion: '16' }));
  assert.equal(deviceResult({ os: 'ios', osVersion: '' }), false);
  for (const method of [device, snapshot]) {
    const params = ajv.compile(method.params);
    assert.ok(params({}));
    assert.equal(params({ extra: true }), false);
  }
});
