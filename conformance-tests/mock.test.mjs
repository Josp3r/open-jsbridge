import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ErrorCode } from '../dist/packages/protocol/src/index.js';
import { createMockAdapter } from '../dist/packages/web-mock/src/index.js';

const maxMessageBytes = 1_048_576;

function frame(rpc, meta) {
  return JSON.stringify({ jsb: '1.0', meta, rpc: { jsonrpc: '2.0', ...rpc } });
}

async function negotiate(adapter) {
  const hello = frame({ id: 'hello', method: 'bridge.hello', params: { protocols: [1] } });
  const { rpc } = JSON.parse(await adapter.send(hello));
  assert.equal(rpc.result.limits.maxMessageBytes, maxMessageBytes);
  return rpc.result.sid;
}

test('Mock drops an oversized hello before it establishes a session', async () => {
  const adapter = createMockAdapter();
  const raw = frame({
    id: 'hello', method: 'bridge.hello', params: { protocols: [1], padding: 'x'.repeat(maxMessageBytes) },
  });

  assert.equal(await adapter.send(raw), null);
  assert.equal(await adapter.send('{'), null);
  await negotiate(adapter);
});

test('Mock drops an oversized UTF-8 request without dispatching it', async () => {
  const adapter = createMockAdapter();
  const sid = await negotiate(adapter);
  const request = (text) => frame({ id: 'echo', method: 'conformance.echo', params: { text } }, { sid });
  const padding = 'x'.repeat(maxMessageBytes - Buffer.byteLength(request('é')));
  const oversized = request(`字${padding}`);

  assert.ok(oversized.length <= maxMessageBytes);
  assert.equal(Buffer.byteLength(oversized), maxMessageBytes + 1);
  assert.equal(await adapter.send(oversized), null);

  const exactLimit = request(`é${padding}`);
  assert.equal(Buffer.byteLength(exactLimit), maxMessageBytes);
  const response = JSON.parse(await adapter.send(exactLimit));
  assert.equal(response.rpc.id, 'echo');
  assert.equal(response.rpc.result.text, `é${padding}`);
});

test('Mock drops oversized notifications and responses without an RPC reply', async () => {
  const adapter = createMockAdapter();
  const sid = await negotiate(adapter);
  const text = 'x'.repeat(maxMessageBytes);
  const notification = frame({ method: 'conformance.echo', params: { text } }, { sid });
  const response = frame({ id: 'echo', result: { text } }, { sid });

  assert.deepEqual(await Promise.all([adapter.send(notification), adapter.send(response)]), [null, null]);
});

test('Mock replaces an oversized echo response with a correlated error', async () => {
  const adapter = createMockAdapter();
  const sid = await negotiate(adapter);
  const values = Array(12).fill('1e-6').join(',');
  const request = (text) => frame({ id: 'echo', method: 'conformance.echo', params: { text, values: [] } }, { sid })
    .replace('"values":[]', `"values":[${values}]`);
  const text = 'x'.repeat(maxMessageBytes - Buffer.byteLength(request('')));
  const raw = request(text);
  const expectedEcho = frame({ id: 'echo', result: { text, values: Array(12).fill(0.000001) } }, { sid });

  assert.equal(Buffer.byteLength(raw), maxMessageBytes);
  assert.ok(Buffer.byteLength(expectedEcho) > maxMessageBytes);

  const reply = await adapter.send(raw);
  const response = JSON.parse(reply);
  assert.equal(response.rpc.id, 'echo');
  assert.equal(response.rpc.error?.code, ErrorCode.PayloadTooLarge);
  assert.equal(response.meta.sid, sid);
  assert.ok(Buffer.byteLength(reply) <= maxMessageBytes);
});
