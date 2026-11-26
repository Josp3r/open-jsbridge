import assert from 'node:assert/strict';
import test from 'node:test';
import { ErrorCode } from '../dist/packages/protocol/src/index.js';
import { createMockAdapter } from '../dist/packages/web-mock/src/index.js';
import { BrowserFallbackAdapter } from '../dist/packages/web-sdk/src/fallback.js';
import { BridgeError, createBridge } from '../dist/packages/web-sdk/src/index.js';

test('bridge.use(plugin) runs onSend, onReceive, and onMetric hooks and supports disposer', async () => {
  const sent = [];
  const received = [];
  const metrics = [];

  const adapter = createMockAdapter({
    handlers: {
      'acme.echo': (params) => ({ echoed: params }),
      'acme.fail': () => { throw new Error('boom'); },
    },
  });

  // Wrap send to inject meta.timing on responses so hostHandlerMs is verified.
  const timedAdapter = {
    name: adapter.name,
    listen: (onMessage) => adapter.listen(onMessage),
    async send(raw) {
      const reply = await adapter.send(raw);
      if (!reply) return null;
      const parsed = JSON.parse(reply);
      if (parsed.rpc && !('method' in parsed.rpc) && parsed.meta?.sid) {
        parsed.meta.timing = { recv: 100, start: 105, end: 120 };
      }
      return JSON.stringify(parsed);
    },
  };

  const bridge = createBridge({ adapter: timedAdapter });
  const dispose = bridge.use({
    name: 'observer',
    onSend(env) {
      sent.push(env.rpc);
      return {
        ...env,
        meta: { ...env.meta, traceId: 'plugin-trace-1' },
      };
    },
    onReceive(env) {
      received.push(env.rpc);
    },
    onMetric(metric) {
      metrics.push(metric);
    },
  });

  // Broken plugin must be isolated from bridge traffic.
  bridge.use({
    name: 'faulty',
    onSend() { throw new Error('send hook crash'); },
    onReceive() { throw new Error('receive hook crash'); },
    onMetric() { throw new Error('metric hook crash'); },
  });

  const ok = await bridge.call('acme.echo', { a: 1 });
  assert.deepEqual(ok, { echoed: { a: 1 } });

  await assert.rejects(bridge.call('acme.fail'), { code: ErrorCode.InternalError });

  assert.equal(sent.length, 2);
  assert.equal(received.length >= 2, true);
  assert.equal(metrics.length, 2);
  assert.equal(metrics[0].method, 'acme.echo');
  assert.equal(metrics[0].code, undefined);
  assert.equal(metrics[0].hostHandlerMs, 15);
  assert.equal(typeof metrics[0].roundTripMs, 'number');
  assert.equal(metrics[1].method, 'acme.fail');
  assert.equal(metrics[1].code, ErrorCode.InternalError);
  assert.equal(metrics[1].hostHandlerMs, 15);

  dispose();
  await bridge.call('acme.echo', { a: 2 });
  assert.equal(metrics.length, 2);
  bridge.close();
});

test('bridge.use(plugin) emits failure metric when a dispatched call times out', async () => {
  const metrics = [];
  const adapter = createMockAdapter({
    handlers: {
      'acme.hang': () => new Promise(() => {}),
    },
  });
  const bridge = createBridge({ adapter });
  bridge.use({ name: 'metrics', onMetric: (m) => metrics.push(m) });

  await assert.rejects(bridge.call('acme.hang', {}, { timeout: 25 }), { code: ErrorCode.Timeout });
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].method, 'acme.hang');
  assert.equal(metrics[0].code, ErrorCode.Timeout);
  assert.ok(metrics[0].roundTripMs >= 0);
  bridge.close();
});

test('BrowserFallbackAdapter runs polyfills outside native hosts and advertises only polyfilled methods', async () => {
  const shown = [];
  const fallback = new BrowserFallbackAdapter({
    polyfills: {
      'ui.toast.show': ({ text }) => { shown.push(String(text)); },
      'acme.compute': async (params) => ({ sum: Number(params?.a ?? 0) + Number(params?.b ?? 0) }),
      'acme.denied': () => { throw new BridgeError(ErrorCode.UserDenied, 'User denied', { data: { reason: 'opt_out' } }); },
      'acme.crash': () => { throw new Error('internal details'); },
    },
  });

  // In Node (no window.__OJSB_TRANSPORT__), createBridge falls back immediately to options.fallback.
  const bridge = createBridge({ fallback, handshakeTimeout: 50 });
  const host = await bridge.ready();
  assert.equal(host.platform, 'browser');
  assert.equal(host.name, 'browser-fallback');
  assert.equal(bridge.has('ui.toast.show', 1), true);
  assert.equal(bridge.has('acme.compute', 1), true);
  assert.equal(bridge.has('device.getInfo', 1), false);

  assert.equal(await bridge.call('ui.toast.show', { text: 'hello' }), null);
  assert.deepEqual(shown, ['hello']);
  assert.deepEqual(await bridge.call('acme.compute', { a: 2, b: 3 }), { sum: 5 });

  await assert.rejects(bridge.call('device.getInfo'), { code: ErrorCode.MethodNotFound });
  await assert.rejects(
    bridge.call('acme.denied'),
    (err) => err.code === ErrorCode.UserDenied && err.data?.reason === 'opt_out',
  );
  await assert.rejects(
    bridge.call('acme.crash'),
    (err) => err.code === ErrorCode.InternalError && err.message === 'Internal error',
  );
  bridge.close();
});
