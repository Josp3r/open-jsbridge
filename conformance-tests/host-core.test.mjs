import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostCore, HostError } from '../dist/packages/host-core/src/index.js';
import { ErrorCode } from '../dist/packages/protocol/src/index.js';
import { createMockAdapter, installMockTransport } from '../dist/packages/web-mock/src/index.js';
import { createBridge } from '../dist/packages/web-sdk/src/index.js';
import { createMediaHelpers } from '../dist/packages/web-sdk/src/media.js';

const jpeg = Uint8Array.of(255, 216, 255, 217);
const thumbnailBase64 = Buffer.from(jpeg).toString('base64');
const mediaHandle = '0123456789abcdef0123456789abcdef';

function frame(rpc, meta) {
  return JSON.stringify({ jsb: '1.0', ...(meta ? { meta } : {}), rpc: { jsonrpc: '2.0', ...rpc } });
}

async function hello(receive, id = 'h-1') {
  const reply = JSON.parse(await receive(frame({ id, method: 'bridge.hello', params: { protocols: [1] } })));
  return reply.rpc.result;
}

test('HostCore supports multi-version methods, HostError, and safe InternalError redaction', async () => {
  const host = createHostCore({ platform: 'rn', name: 'rn-test', version: '1.0.0' });
  host.register('acme.profile.get', (_params, ctx) => ({ version: ctx.version }), { versions: [1, 2] });
  host.register('acme.pay.create', () => {
    throw new HostError(ErrorCode.UserDenied, 'User denied', { reason: 'biometric_cancelled' });
  });
  host.register('acme.bug.crash', () => {
    throw new Error('sensitive internal stack detail');
  });

  const session = await hello(host.receive);
  assert.deepEqual(session.capabilities.methods['acme.profile.get'], { versions: [1, 2] });
  assert.equal(session.host.platform, 'rn');

  const v1 = JSON.parse(await host.receive(frame({ id: 'r-1', method: 'acme.profile.get' }, { sid: session.sid })));
  assert.deepEqual(v1.rpc.result, { version: 1 });

  const v2 = JSON.parse(await host.receive(frame({ id: 'r-2', method: 'acme.profile.get@2' }, { sid: session.sid })));
  assert.deepEqual(v2.rpc.result, { version: 2 });

  const v3 = JSON.parse(await host.receive(frame({ id: 'r-3', method: 'acme.profile.get@3' }, { sid: session.sid })));
  assert.equal(v3.rpc.error.code, ErrorCode.MethodNotFound);
  assert.equal(v3.rpc.error.data.reason, 'version_unsupported');

  const denied = JSON.parse(await host.receive(frame({ id: 'r-4', method: 'acme.pay.create' }, { sid: session.sid })));
  assert.equal(denied.rpc.error.code, ErrorCode.UserDenied);
  assert.deepEqual(denied.rpc.error.data, { reason: 'biometric_cancelled' });

  const crashed = JSON.parse(await host.receive(frame({ id: 'r-5', method: 'acme.bug.crash' }, { sid: session.sid })));
  assert.equal(crashed.rpc.error.code, ErrorCode.InternalError);
  assert.equal(crashed.rpc.error.message, 'Internal error');
});

test('HostCore enforces maxInflight and serial concurrency limits', async () => {
  const host = createHostCore({ limits: { maxInflight: 2 } });
  const resolvers = [];
  host.register('acme.slow', () => new Promise((resolve) => { resolvers.push(resolve); }));
  host.register('acme.serial', () => new Promise((resolve) => { resolvers.push(resolve); }), { concurrency: 'serial' });

  const { sid } = await hello(host.receive);

  const s1 = host.receive(frame({ id: 's-1', method: 'acme.serial' }, { sid }));
  const s2 = JSON.parse(await host.receive(frame({ id: 's-2', method: 'acme.serial' }, { sid })));
  assert.equal(s2.rpc.error.code, ErrorCode.Busy);

  const p1 = host.receive(frame({ id: 'p-1', method: 'acme.slow' }, { sid }));
  const p2 = JSON.parse(await host.receive(frame({ id: 'p-2', method: 'acme.slow' }, { sid })));
  assert.equal(p2.rpc.error.code, ErrorCode.RateLimited);

  resolvers.shift()({ ok: 'serial' });
  resolvers.shift()({ ok: 'slow' });
  assert.deepEqual(JSON.parse(await s1).rpc.result, { ok: 'serial' });
  assert.deepEqual(JSON.parse(await p1).rpc.result, { ok: 'slow' });

  const s3Promise = host.receive(frame({ id: 's-3', method: 'acme.serial' }, { sid }));
  resolvers.shift()({ ok: 'serial-again' });
  assert.deepEqual(JSON.parse(await s3Promise).rpc.result, { ok: 'serial-again' });
});

test('HostCore propagates bridge.cancel to AbortSignal and aborts inflight calls on reset', async () => {
  const host = createHostCore({ supportsCancel: true });
  let abortedReason;
  let releasePending;
  host.register('acme.wait', (_params, ctx) => new Promise((resolve) => {
    releasePending = resolve;
    ctx.signal.addEventListener('abort', () => {
      abortedReason = ctx.signal.reason;
      resolve({ late: true });
    }, { once: true });
  }));

  const session = await hello(host.receive);
  assert.deepEqual(session.capabilities.features, ['cancel']);

  const callPromise = host.receive(frame({ id: 'c-1', method: 'acme.wait' }, { sid: session.sid }));
  const cancelReply = await host.receive(frame(
    { method: 'bridge.cancel', params: { requestId: 'c-1', reason: 'abort' } },
    { sid: session.sid },
  ));
  assert.equal(cancelReply, null);
  assert.equal(abortedReason, 'abort');
  assert.equal(host.wasCancelled('c-1'), true);
  assert.equal(JSON.parse(await callPromise).rpc.error.code, ErrorCode.Cancelled);

  // Session reset must abort inflight calls and suppress late replies.
  let resetAborted = false;
  host.register('acme.waitReset', (_params, ctx) => new Promise((resolve) => {
    releasePending = resolve;
    ctx.signal.addEventListener('abort', () => { resetAborted = true; }, { once: true });
  }));
  const pendingReset = host.receive(frame({ id: 'c-2', method: 'acme.waitReset' }, { sid: session.sid }));
  host.reset();
  assert.equal(resetAborted, true);
  releasePending({ stale: true });
  assert.equal(await pendingReset, null);
});

test('Mock supports media.chooseMedia with serial enforcement and Web media helpers', async () => {
  let resolveFirst;
  let calls = 0;
  const adapter = createMockAdapter({
    chooseMedia: () => {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve) => { resolveFirst = resolve; });
      }
      return { status: 'cancelled', files: [] };
    },
  });
  const bridge = createBridge({ adapter });
  const { media } = createMediaHelpers(bridge);

  await bridge.ready();
  assert.equal(bridge.has('media.chooseMedia', 1), true);

  await assert.rejects(
    bridge.call('media.chooseMedia@1', { count: 2 }),
    { code: ErrorCode.InvalidParams },
  );

  const first = media.chooseMedia();
  await assert.rejects(media.chooseMedia(), { code: ErrorCode.Busy });

  resolveFirst({
    status: 'selected',
    files: [{
      type: 'image',
      id: mediaHandle,
      mime: 'image/jpeg',
      size: 1024,
      width: 640,
      height: 480,
      expiresAt: Date.now() + 60_000,
      thumbnailBase64,
    }],
  });

  const selected = await first;
  assert.equal(selected.status, 'selected');
  assert.equal(selected.files[0].id, mediaHandle);
  assert.ok(selected.files[0].thumbUrl.startsWith('blob:'));
  bridge.close();
});

test('Mock supports custom handlers, failNext fault injection, latency, and bridge.cancel', async () => {
  let observedAbort = false;
  let observedId;
  const adapter = createMockAdapter({
    supportsCancel: true,
    latency: 5,
    handlers: {
      'acme.greet': (params) => ({ greeting: `hello ${String(params?.name ?? 'world')}` }),
    },
  });
  adapter.register('acme.hang', (_params, ctx) => new Promise((resolve) => {
    observedId = ctx.id;
    ctx.signal.addEventListener('abort', () => {
      observedAbort = true;
      resolve({});
    }, { once: true });
  }));

  const bridge = createBridge({ adapter });
  await bridge.ready();

  adapter.failNext('acme.greet', { code: ErrorCode.PermissionDenied, message: 'Denied once', data: { retryable: false } });
  await assert.rejects(
    bridge.call('acme.greet', { name: 'ojsb' }),
    (error) => error.code === ErrorCode.PermissionDenied && error.data?.retryable === false,
  );
  assert.deepEqual(await bridge.call('acme.greet', { name: 'ojsb' }), { greeting: 'hello ojsb' });

  const controller = new AbortController();
  const pending = bridge.call('acme.hang', {}, { signal: controller.signal });
  // Wait long enough for latency + dispatch before aborting.
  await new Promise((resolve) => setTimeout(resolve, 25));
  controller.abort();
  await assert.rejects(pending, { code: ErrorCode.Cancelled });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(observedAbort, true);
  assert.equal(adapter.wasCancelled(observedId), true);
  bridge.close();
});

test('installMockTransport exposes register and failNext handles on window', async (t) => {
  const target = new EventTarget();
  const needsCustomEvent = typeof CustomEvent === 'undefined';
  if (needsCustomEvent) globalThis.CustomEvent = class CustomEvent extends Event {};
  Object.defineProperty(globalThis, 'window', { value: target, configurable: true });
  t.after(() => {
    delete globalThis.window;
    if (needsCustomEvent) delete globalThis.CustomEvent;
  });

  const host = installMockTransport();
  assert.ok(host);
  host.register('acme.ping', () => ({ pong: true }));

  const bridge = createBridge();
  assert.deepEqual(await bridge.call('acme.ping'), { pong: true });

  host.failNext('acme.ping', { code: ErrorCode.Busy, message: 'Temporarily busy' });
  await assert.rejects(bridge.call('acme.ping'), { code: ErrorCode.Busy });
  assert.deepEqual(await bridge.call('acme.ping'), { pong: true });
  bridge.close();
});
