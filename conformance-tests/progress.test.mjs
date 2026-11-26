import assert from 'node:assert/strict';
import test from 'node:test';
import { ErrorCode } from '../dist/packages/protocol/src/index.js';
import { createMockAdapter } from '../dist/packages/web-mock/src/index.js';
import { createBridge } from '../dist/packages/web-sdk/src/index.js';

function createManualHarness() {
  let push;
  const sent = [];
  const adapter = {
    name: 'manual',
    protocols: [1],
    send(raw) {
      sent.push(JSON.parse(raw));
    },
    listen(onMessage) {
      push = onMessage;
      return () => { push = undefined; };
    },
  };
  const deliver = (frame) => push?.(JSON.stringify(frame));
  const hello = async (sid = 's-1', methods = { 'conformance.stream': { versions: [1] } }) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const req = sent.shift();
    assert.equal(req.rpc.method, 'bridge.hello');
    assert.ok(req.rpc.params.wants.includes('callbacks'));
    deliver({
      jsb: '1.0',
      meta: { sid },
      rpc: {
        jsonrpc: '2.0',
        id: req.rpc.id,
        result: {
          jsb: '1.0',
          sid,
          host: { platform: 'mock', name: 'manual', version: '1.0.0' },
          capabilities: { methods, events: [], features: ['cancel', 'callbacks'] },
          limits: { maxMessageBytes: 65536, maxInflight: 8, defaultTimeoutMs: 5000 },
        },
      },
    });
    return sid;
  };
  return { adapter, sent, deliver, hello };
}

test('Web SDK and Mock deliver ordered streaming callbacks before final response', async () => {
  const adapter = createMockAdapter({ supportsCallbacks: true });
  adapter.register('conformance.stream', async (params, ctx) => {
    const count = Number(params?.n ?? 3);
    for (let i = 0; i < count; i += 1) {
      assert.equal(ctx.callback({ step: i }), true);
    }
    assert.equal(ctx.callback(), true);
    return { done: count };
  });

  const bridge = createBridge({ adapter });
  const received = [];
  const result = await bridge.call('conformance.stream', { n: 3 }, {
    onCallback: (chunk, seq) => received.push({ chunk, seq }),
  });

  assert.deepEqual(result, { done: 3 });
  assert.deepEqual(received, [
    { chunk: { step: 0 }, seq: 0 },
    { chunk: { step: 1 }, seq: 1 },
    { chunk: { step: 2 }, seq: 2 },
    { chunk: undefined, seq: 3 },
  ]);
  bridge.close();
});

test('Web SDK rejects non-function onCallback with InvalidParams', async () => {
  const bridge = createBridge({ adapter: createMockAdapter() });
  await assert.rejects(
    bridge.call('conformance.echo', {}, { onCallback: 'not-a-fn' }),
    { code: ErrorCode.InvalidParams },
  );
  bridge.close();
});

test('Web SDK drops duplicate, out-of-order, wrong-sid, unknown-id, and post-settlement progress', async () => {
  const { adapter, sent, deliver, hello } = createManualHarness();
  const bridge = createBridge({ adapter });
  const received = [];
  const callPromise = bridge.call('conformance.stream', {}, {
    onCallback: (chunk, seq) => received.push([seq, chunk]),
  });

  const sid = await hello('s-active');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const req = sent.shift();
  const id = req.rpc.id;

  const sendProgress = (progressSid, params) => deliver({
    jsb: '1.0',
    meta: { sid: progressSid },
    rpc: { jsonrpc: '2.0', method: 'bridge.progress', params },
  });

  // Wrong SID, unknown requestId, and invalid seq are ignored.
  sendProgress('s-stale', { requestId: id, seq: 0, chunk: 'stale' });
  sendProgress(sid, { requestId: 'unknown', seq: 0, chunk: 'unknown' });
  sendProgress(sid, { requestId: id, seq: -1, chunk: 'negative' });
  sendProgress(sid, { requestId: id, seq: 1.5, chunk: 'float' });

  // Strictly increasing seq only: 0 -> 2 -> (drop 1, drop 2) -> 3.
  sendProgress(sid, { requestId: id, seq: 0, chunk: 'a' });
  sendProgress(sid, { requestId: id, seq: 2, chunk: 'b' });
  sendProgress(sid, { requestId: id, seq: 1, chunk: 'out-of-order' });
  sendProgress(sid, { requestId: id, seq: 2, chunk: 'duplicate' });
  sendProgress(sid, { requestId: id, seq: 3, chunk: 'c' });

  deliver({
    jsb: '1.0',
    meta: { sid },
    rpc: { jsonrpc: '2.0', id, result: { ok: true } },
  });

  assert.deepEqual(await callPromise, { ok: true });

  // Late progress after settlement must be ignored.
  sendProgress(sid, { requestId: id, seq: 4, chunk: 'late' });
  assert.deepEqual(received, [[0, 'a'], [2, 'b'], [3, 'c']]);
  bridge.close();
});

test('idleTimeout resets deadline on dispatched progress and ignores duplicate seq', async () => {
  const { adapter, sent, deliver, hello } = createManualHarness();
  const bridge = createBridge({ adapter });
  const received = [];
  const callPromise = bridge.call('conformance.stream', {}, {
    timeout: 60,
    idleTimeout: true,
    onCallback: (chunk, seq) => received.push([seq, chunk]),
  });

  const sid = await hello('s-idle');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const id = sent.shift().rpc.id;

  // Send 3 chunks spaced 35ms apart (total 105ms > 60ms timeout), keeping call alive.
  for (let seq = 0; seq < 3; seq += 1) {
    await new Promise((resolve) => setTimeout(resolve, 35));
    deliver({
      jsb: '1.0',
      meta: { sid },
      rpc: { jsonrpc: '2.0', method: 'bridge.progress', params: { requestId: id, seq, chunk: seq } },
    });
  }

  deliver({
    jsb: '1.0',
    meta: { sid },
    rpc: { jsonrpc: '2.0', id, result: { finished: true } },
  });
  assert.deepEqual(await callPromise, { finished: true });
  assert.deepEqual(received, [[0, 0], [1, 1], [2, 2]]);

  // Duplicate seq must NOT extend the idle timeout.
  const idleCall = bridge.call('conformance.stream', {}, {
    timeout: 50,
    idleTimeout: true,
    onCallback: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const idleId = sent.shift().rpc.id;
  deliver({
    jsb: '1.0',
    meta: { sid },
    rpc: { jsonrpc: '2.0', method: 'bridge.progress', params: { requestId: idleId, seq: 0, chunk: 'first' } },
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  deliver({
    jsb: '1.0',
    meta: { sid },
    rpc: { jsonrpc: '2.0', method: 'bridge.progress', params: { requestId: idleId, seq: 0, chunk: 'dup' } },
  });
  await assert.rejects(idleCall, { code: ErrorCode.Timeout });
  bridge.close();
});

test('HostCore drops callbacks when disabled, cancelled, or given invalid/oversized payloads', async () => {
  const disabled = createMockAdapter();
  let disabledResult;
  disabled.register('conformance.stream', (_params, ctx) => {
    disabledResult = ctx.callback({ step: 0 });
    return {};
  });
  const b1 = createBridge({ adapter: disabled });
  await b1.call('conformance.stream');
  assert.equal(disabledResult, false);
  b1.close();

  const adapter = createMockAdapter({
    supportsCallbacks: true,
    supportsCancel: true,
    limits: { maxMessageBytes: 512 },
  });
  let postCancelResult;
  let invalidResult;
  let oversizedResult;
  adapter.register('conformance.stream', (_params, ctx) => new Promise((resolve) => {
    ctx.signal.addEventListener('abort', () => {
      postCancelResult = ctx.callback({ late: true });
      resolve({});
    }, { once: true });
    const cyclic = {};
    cyclic.self = cyclic;
    invalidResult = ctx.callback(cyclic);
    oversizedResult = ctx.callback({ pad: 'x'.repeat(600) });
    assert.equal(ctx.callback({ ok: true }), true);
  }));

  const bridge = createBridge({ adapter });
  const controller = new AbortController();
  const seen = [];
  const call = bridge.call('conformance.stream', {}, {
    signal: controller.signal,
    onCallback: (chunk, seq) => {
      seen.push([seq, chunk]);
      controller.abort();
    },
  });

  await assert.rejects(call, { code: ErrorCode.Cancelled });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(invalidResult, false);
  assert.equal(oversizedResult, false);
  assert.equal(postCancelResult, false);
  assert.deepEqual(seen, [[0, { ok: true }]]);
  bridge.close();
});
