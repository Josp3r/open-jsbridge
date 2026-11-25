import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { createBridge, ErrorCode } from '../dist/packages/web-sdk/src/index.js';
import { createMediaHelpers } from '../dist/packages/web-sdk/src/media.js';

const handle = '0123456789abcdef0123456789abcdef';
const jpeg = Uint8Array.of(255, 216, 255, 217);
const thumbnailBase64 = Buffer.from(jpeg).toString('base64');
const resource = {
  type: 'image', id: handle, mime: 'image/png', size: 1800,
  width: 800, height: 640, expiresAt: Date.now() + 300_000, thumbnailBase64,
};
const cancelled = { status: 'cancelled', files: [] };

test('media v1 schemas allow only single-image selection with bounded JPEG data', () => {
  const load = (path) => JSON.parse(readFileSync(new URL(`../spec/${path}.json`, import.meta.url), 'utf8'));
  const ajv = new Ajv2020({ strictRequired: true });
  ajv.addSchema(load('schemas/media-id'));
  const choose = load('methods/media/chooseMedia');
  const params = ajv.compile(choose.params);
  assert.ok(params({}));
  assert.ok(params({ count: 1, sourceType: ['album'], mediaType: ['image'] }));
  for (const invalid of [{ count: 2 }, { mediaType: ['video'] }, { sourceType: ['camera'] }, { extra: true }]) {
    assert.equal(params(invalid), false);
  }
  const result = ajv.compile(choose.result);
  const selected = (file) => ({ status: 'selected', files: [file] });
  assert.ok(result(selected(resource)));
  assert.ok(result(cancelled));
  assert.equal(result(selected({ ...resource, thumbnailBase64: Buffer.alloc(32769).toString('base64') })), false);
  assert.equal(result(selected({ ...resource, thumbnailBase64: 'AB==' })), false);
  assert.equal(result(selected({ ...resource, id: 'file:///photo.png' })), false);
  assert.equal(result(selected({ ...resource, size: 20971521 })), false);
  assert.equal(result(selected({ ...resource, blobRef: handle })), false);
});

function setup(t, choose) {
  const window = new EventTarget();
  const requests = [];
  let counter = 0;
  let sid;
  window.__OJSB_TRANSPORT__ = {
    name: 'media-test',
    protocols: [1],
    async postMessage(raw) {
      const { rpc } = JSON.parse(raw);
      requests.push(rpc.method);
      if (rpc.method === 'bridge.cancel') return null;
      if (rpc.method === 'bridge.hello') {
        sid = `document-${++counter}`;
        return JSON.stringify({ jsb: '1.0', rpc: { jsonrpc: '2.0', id: rpc.id, result: {
          jsb: '1.0', sid, host: { platform: 'ios', name: 'media-test', version: '1' },
          capabilities: { methods: { 'media.chooseMedia': { versions: [1] } }, events: [], features: ['cancel'] },
          limits: { maxMessageBytes: 65536, maxInflight: 1, defaultTimeoutMs: 15000 },
        } } });
      }
      const route = sid;
      assert.equal(rpc.method, 'media.chooseMedia@1');
      return JSON.stringify({ jsb: '1.0', meta: { sid: route }, rpc: {
        jsonrpc: '2.0', id: rpc.id, result: await choose(rpc),
      } });
    },
  };
  Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
  t.after(() => {
    window.dispatchEvent(new Event('pagehide'));
    delete globalThis.window;
  });
  const bridge = createBridge();
  const { media } = createMediaHelpers(bridge);
  return { window, bridge, media, requests };
}

test('Web exposes only a revocable JPEG object URL and the original metadata', async (t) => {
  let selection = { status: 'selected', files: [resource] };
  const { media, bridge, window, requests } = setup(t, () => selection);
  const { files: [file] } = await media.chooseMedia();
  assert.equal(file.id, handle);
  assert.ok(file.thumbUrl.startsWith('blob:'));
  assert.equal(file.width, resource.width);
  assert.equal('thumbnailBase64' in file, false);
  assert.equal('blobRef' in file, false);
  const thumbnail = await fetch(file.thumbUrl);
  assert.equal(thumbnail.headers.get('Content-Type'), 'image/jpeg');
  assert.deepEqual(new Uint8Array(await thumbnail.arrayBuffer()), jpeg);
  assert.equal(bridge.has('bridge.blob.read', 1), false);
  assert.equal(bridge.has('bridge.blob.release', 1), false);
  await assert.rejects(bridge.call('bridge.blob.read@1', { blobRef: handle, index: 0 }), { code: ErrorCode.MethodNotFound });
  window.dispatchEvent(new Event('pagehide'));
  await assert.rejects(fetch(file.thumbUrl));
  const restored = new Event('pageshow');
  Object.defineProperty(restored, 'persisted', { value: true });
  window.dispatchEvent(restored);
  await bridge.ready();
  selection = cancelled;
  assert.deepEqual(await media.chooseMedia(), cancelled);
  assert.deepEqual(requests, ['bridge.hello', 'media.chooseMedia@1', 'bridge.hello', 'media.chooseMedia@1']);
});

test('Web rejects over-limit and malformed thumbnails before returning an object URL', async (t) => {
  let source = thumbnailBase64;
  const { media } = setup(t, () => ({ status: 'selected', files: [{ ...resource, thumbnailBase64: source }] }));
  for (const invalid of ['bm90LWpwZWc=', 'AB==', Buffer.alloc(32769).toString('base64')]) {
    source = invalid;
    await assert.rejects(media.chooseMedia(), { code: ErrorCode.InternalError });
  }
});

test('Web revokes a thumbnail at its negotiated expiry', async (t) => {
  const { media, bridge } = setup(t, () => ({
    status: 'selected', files: [{ ...resource, expiresAt: Date.now() + 1_000 }],
  }));
  await bridge.ready();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const { files: [{ thumbUrl }] } = await media.chooseMedia();
  t.mock.timers.tick(999);
  assert.equal((await fetch(thumbUrl)).ok, true);
  t.mock.timers.tick(1);
  await assert.rejects(fetch(thumbUrl));
});

test('hiding a document cancels selection before the late thumbnail is delivered', async (t) => {
  let start;
  const started = new Promise((resolve) => { start = resolve; });
  let deliver;
  const { media, window } = setup(t, () => new Promise((resolve) => { deliver = resolve; start(); }));
  const pending = assert.rejects(media.chooseMedia(), { code: ErrorCode.Cancelled });
  await started;
  window.dispatchEvent(new Event('pagehide'));
  deliver({ status: 'selected', files: [resource] });
  await pending;
});
