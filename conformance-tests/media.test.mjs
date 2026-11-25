import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import * as sdk from '../dist/packages/web-sdk/src/index.js';
import { createMediaHelpers } from '../dist/packages/web-sdk/src/media.js';

const reference = '0123456789abcdef0123456789abcdef';
const bytes = Buffer.alloc(65_541);
for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
const selected = {
  status: 'selected',
  files: [{ type: 'image', blobRef: reference, mime: 'image/png', size: bytes.length, expiresAt: 1_800_000_000_000 }],
};
const cancelled = { status: 'cancelled', files: [] };
const methods = ['media.chooseMedia', 'bridge.blob.read', 'bridge.blob.release'];

test('media v1 schemas enforce the single-image and bounded chunk contracts', () => {
  const load = (path) => JSON.parse(readFileSync(new URL(`../spec/${path}.json`, import.meta.url), 'utf8'));
  const ajv = new Ajv2020({ strictRequired: true });
  ajv.addSchema(load('schemas/blob-ref'));
  const choose = load('methods/media/chooseMedia');
  const read = load('methods/bridge/blob/read');
  const release = load('methods/bridge/blob/release');
  const chooseParams = ajv.compile(choose.params);
  assert.ok(chooseParams({}));
  assert.ok(chooseParams({ count: 1, sourceType: ['album'], mediaType: ['image'] }));
  for (const params of [{ count: 2 }, { mediaType: ['video'] }, { sourceType: ['camera'] }, { extra: true }]) {
    assert.equal(chooseParams(params), false);
  }
  const chooseResult = ajv.compile(choose.result);
  assert.ok(chooseResult(selected));
  assert.ok(chooseResult(cancelled));
  assert.equal(chooseResult({ status: 'selected', files: [] }), false);
  assert.equal(chooseResult({ ...selected, files: [{ ...selected.files[0], size: 20_971_521 }] }), false);
  const readParams = ajv.compile(read.params);
  assert.ok(readParams({ blobRef: reference, index: 0 }));
  assert.ok(readParams({ blobRef: reference, index: 319 }));
  for (const index of [-1, 320, 0.5, '0']) {
    assert.equal(readParams({ blobRef: reference, index }), false);
  }
  assert.equal(readParams({ blobRef: reference }), false);
  assert.equal(readParams({ blobRef: reference, index: 0, sid: 'other' }), false);
  const readResult = ajv.compile(read.result);
  const fullChunk = bytes.subarray(0, 65_536).toString('base64');
  assert.ok(readResult({ dataBase64: fullChunk, done: false }));
  assert.ok(readResult({ dataBase64: fullChunk, done: true }));
  assert.ok(readResult({ dataBase64: 'YQ==', done: true }));
  assert.equal(readResult({ dataBase64: 'YQ==', done: false }), false);
  assert.equal(readResult({ dataBase64: fullChunk }), false);
  assert.equal(readResult({ dataBase64: fullChunk, done: true, size: 65_536 }), false);
  for (const dataBase64 of ['', '%%%%', 'A=A=', 'AA=\n', 'YQ==\n', 'YR==', 'YWJ=',
    bytes.subarray(0, 65_537).toString('base64'), bytes.subarray(0, 65_538).toString('base64')]) {
    assert.equal(readResult({ dataBase64, done: true }), false);
  }
  const releaseParams = ajv.compile(release.params);
  assert.ok(releaseParams({ blobRef: reference }));
  for (const blobRef of [reference.slice(1), reference + 'a', reference.toUpperCase(), reference + '\n', 'file:///path']) {
    assert.equal(releaseParams({ blobRef }), false);
    assert.equal(readParams({ blobRef, index: 0 }), false);
  }
  assert.equal(releaseParams({ blobRef: reference, expiresAt: 1 }), false);
  const releaseResult = ajv.compile(release.result);
  assert.ok(releaseResult({}));
  assert.equal(releaseResult({ released: true }), false);
});

test('the installed Web APIs assemble bytes, distinguish picker dismissal, and handle invalid or released chunks', async (t) => {
  let released = false;
  let dismiss = false;
  let invalidChunk;
  let readBytes = bytes;
  let onRead;
  const requests = [];
  const sid = 'media-document';
  const window = new EventTarget();
  window.__OJSB_TRANSPORT__ = {
    name: 'test-media',
    protocols: [1],
    async postMessage(raw) {
      const { rpc, meta } = JSON.parse(raw);
      requests.push({ method: rpc.method, params: rpc.params, meta });
      const respond = (content) => JSON.stringify({
        jsb: '1.0', meta: { sid }, rpc: { jsonrpc: '2.0', id: rpc.id, ...content },
      });
      if (rpc.method === 'bridge.hello') {
        return respond({ result: {
          jsb: '1.0', sid, host: { platform: 'ios', name: 'test-picker', version: '1' },
          capabilities: {
            methods: Object.fromEntries(methods.map((method) => [method, { versions: [1] }])),
            events: [], features: ['blob', 'cancel'],
          },
          limits: { maxMessageBytes: 1_048_576, maxInflight: 1, defaultTimeoutMs: 15_000 },
        } });
      }
      if (rpc.method === 'media.chooseMedia@1') return respond({ result: dismiss ? cancelled : selected });
      if (rpc.method === 'bridge.cancel') return null;
      if (rpc.method === 'bridge.blob.release@1') {
        released = true;
        return respond({ result: {} });
      }
      assert.equal(rpc.method, 'bridge.blob.read@1');
      assert.equal(rpc.params.blobRef, reference);
      if (released) return respond({ error: { code: sdk.ErrorCode.PermissionDenied, message: 'Permission denied' } });
      const offset = rpc.params.index * 65_536;
      onRead?.();
      return respond({ result: {
        dataBase64: readBytes.subarray(offset, offset + 65_536).toString('base64'),
        done: offset + 65_536 >= readBytes.length,
        ...invalidChunk,
      } });
    },
  };
  Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
  t.after(() => { delete globalThis.window; });

  const result = await sdk.media.chooseMedia({ count: 1 });
  assert.deepEqual(result, selected);
  assert.ok(requests.find(({ method }) => method === 'media.chooseMedia@1').meta.timeout > 100_000);
  const file = await sdk.blob.read(result.files[0]);
  assert.equal(file.type, 'image/png');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
  assert.deepEqual(requests.filter(({ method }) => method === 'bridge.blob.read@1').map(({ params }) => params.index), [0, 1]);
  invalidChunk = { done: true };
  await assert.rejects(sdk.blob.read(result.files[0]), { code: sdk.ErrorCode.InternalError });
  invalidChunk = { dataBase64: 'YQ \n', done: true };
  await assert.rejects(sdk.blob.read({ ...result.files[0], size: 1 }), { code: sdk.ErrorCode.InternalError });
  await assert.rejects(sdk.blob.read({ ...result.files[0], size: 20_971_521 }), { code: sdk.ErrorCode.InvalidParams });

  invalidChunk = undefined;
  readBytes = bytes.subarray(0, 65_536);
  const exactChunk = await sdk.blob.read({ ...result.files[0], size: readBytes.length });
  assert.deepEqual(Buffer.from(await exactChunk.arrayBuffer()), readBytes);

  readBytes = bytes;
  const abort = new AbortController();
  onRead = () => abort.abort();
  const beforeAbort = requests.length;
  await assert.rejects(sdk.blob.read(result.files[0], { signal: abort.signal }), { code: sdk.ErrorCode.Cancelled });
  assert.deepEqual(requests.slice(beforeAbort).map(({ method }) => method), ['bridge.blob.read@1', 'bridge.cancel']);
  onRead = undefined;

  assert.deepEqual(await sdk.blob.release(reference), {});
  assert.deepEqual(await sdk.blob.release(reference), {});
  await assert.rejects(sdk.blob.read(result.files[0]), { code: sdk.ErrorCode.PermissionDenied });
  dismiss = true;
  assert.deepEqual(await sdk.media.chooseMedia(), cancelled);
});

test('pagehide cancels a pending blob read and a restored session cannot resume the old reference', async (t) => {
  const window = new EventTarget();
  const requests = [];
  const sessions = [];
  let deliverOldChunk;
  let observeOldRequest;
  const requestedOldChunk = new Promise((resolve) => { observeOldRequest = resolve; });
  window.__OJSB_TRANSPORT__ = {
    name: 'test-media-lifecycle',
    protocols: [1],
    async postMessage(raw) {
      const { rpc, meta } = JSON.parse(raw);
      const reply = (sid, payload) => JSON.stringify({
        jsb: '1.0', meta: { sid }, rpc: { jsonrpc: '2.0', id: rpc.id, ...payload },
      });
      if (rpc.method === 'bridge.hello') {
        const sid = sessions.length === 0 ? 'before-pagehide' : 'after-pageshow';
        sessions.push(sid);
        return reply(sid, { result: {
          jsb: '1.0', sid, host: { platform: 'ios', name: 'test-picker', version: '1' },
          capabilities: {
            methods: { 'bridge.blob.read': { versions: [1] }, 'bridge.blob.release': { versions: [1] } },
            events: [], features: ['blob'],
          },
          limits: { maxMessageBytes: 1_048_576, maxInflight: 1, defaultTimeoutMs: 15_000 },
        } });
      }
      assert.equal(rpc.method, 'bridge.blob.read@1');
      requests.push({ sid: meta.sid, ...rpc.params });
      if (meta.sid === 'before-pagehide') {
        return new Promise((resolve) => {
          deliverOldChunk = () => resolve(reply(meta.sid, { result: {
            dataBase64: bytes.subarray(0, 65_536).toString('base64'), done: false,
          } }));
          observeOldRequest();
        });
      }
      return reply(meta.sid, { error: { code: sdk.ErrorCode.PermissionDenied, message: 'Permission denied' } });
    },
  };
  Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
  t.after(() => {
    window.dispatchEvent(new Event('pagehide'));
    delete globalThis.window;
  });
  const client = sdk.createBridge();
  const { blob } = createMediaHelpers(client);
  const resource = selected.files[0];

  const reading = blob.read(resource);
  const cancellation = assert.rejects(reading, { code: sdk.ErrorCode.Cancelled });
  await requestedOldChunk;
  window.dispatchEvent(new Event('pagehide'));
  await cancellation;

  const restored = new Event('pageshow');
  Object.defineProperty(restored, 'persisted', { value: true });
  window.dispatchEvent(restored);
  await client.ready();
  deliverOldChunk();
  await assert.rejects(blob.read(resource), { code: sdk.ErrorCode.PermissionDenied });
  assert.deepEqual(sessions, ['before-pagehide', 'after-pageshow']);
  assert.deepEqual(requests, [
    { sid: 'before-pagehide', blobRef: reference, index: 0 },
    { sid: 'after-pageshow', blobRef: reference, index: 0 },
  ]);
});
