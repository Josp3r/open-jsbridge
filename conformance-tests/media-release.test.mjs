import assert from 'node:assert/strict';
import test from 'node:test';
import { ErrorCode } from '../dist/packages/protocol/src/index.js';
import { createMockAdapter, HostError } from '../dist/packages/web-mock/src/index.js';
import { BridgeError, createBridge } from '../dist/packages/web-sdk/src/index.js';
import { createMediaHelpers } from '../dist/packages/web-sdk/src/media.js';

const idA = '0123456789abcdef0123456789abcdef';
const idB = 'fedcba9876543210fedcba9876543210';
const jpeg = Uint8Array.of(255, 216, 255, 217);
const thumbnailBase64 = Buffer.from(jpeg).toString('base64');

test('media.release@1 is optional and rejects with MethodNotFound when unadvertised', async () => {
  const sentMethods = [];
  const baseAdapter = createMockAdapter();
  const spyAdapter = {
    name: baseAdapter.name,
    listen: (cb) => baseAdapter.listen(cb),
    send(raw) {
      sentMethods.push(JSON.parse(raw).rpc.method);
      return baseAdapter.send(raw);
    },
  };
  const bridge = createBridge({ adapter: spyAdapter });
  const { media } = createMediaHelpers(bridge);

  await bridge.ready();
  assert.equal(bridge.has('media.release', 1), false);
  await assert.rejects(
    media.release({ ids: [idA] }),
    (error) => error instanceof BridgeError && error.code === ErrorCode.MethodNotFound,
  );
  assert.deepEqual(sentMethods, ['bridge.hello']);
  bridge.close();
});

test('media.release@1 releases handles with null result while preserving page thumbUrl lifecycle', async () => {
  const releasedBatches = [];
  const adapter = createMockAdapter({
    chooseMedia: () => ({
      status: 'selected',
      files: [{
        type: 'image',
        id: idA,
        mime: 'image/jpeg',
        size: 2048,
        width: 400,
        height: 300,
        expiresAt: Date.now() + 300_000,
        thumbnailBase64,
      }],
    }),
    releaseMedia: (ids, ctx) => {
      releasedBatches.push({ sid: ctx.sid, ids: [...ids] });
    },
  });

  const bridge = createBridge({ adapter });
  const { media } = createMediaHelpers(bridge);
  await bridge.ready();
  assert.equal(bridge.has('media.release', 1), true);

  const selection = await media.chooseMedia();
  assert.equal(selection.status, 'selected');
  const [file] = selection.files;

  // Release including repeated IDs & unknown IDs succeeds with null and deduplicates in host callback.
  const releaseResult = await media.release({ ids: [file.id, file.id, idB] });
  assert.equal(releaseResult, null);
  assert.equal(releasedBatches.length, 1);
  assert.deepEqual(releasedBatches[0].ids, [idA, idB]);
  assert.ok(releasedBatches[0].sid);

  // Page's already-obtained thumbUrl stays valid after native handle release until expiry / close().
  const res = await fetch(file.thumbUrl);
  assert.equal(res.ok, true);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), jpeg);

  // Closing the bridge revokes the preview object URL.
  bridge.close();
  await assert.rejects(fetch(file.thumbUrl));
});

test('media.release@1 enforces 1..32 batch validation atomically on both Web SDK and Mock host', async () => {
  const releasedBatches = [];
  const sentMethods = [];
  const baseAdapter = createMockAdapter({
    releaseMedia: (ids) => {
      releasedBatches.push([...ids]);
    },
  });
  const spyAdapter = {
    name: baseAdapter.name,
    listen: (cb) => baseAdapter.listen(cb),
    send(raw) {
      sentMethods.push(JSON.parse(raw).rpc.method);
      return baseAdapter.send(raw);
    },
  };
  const bridge = createBridge({ adapter: spyAdapter });
  const { media } = createMediaHelpers(bridge);
  await bridge.ready();

  const maxBatch = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(32, '0'));
  assert.equal(await media.release({ ids: maxBatch }), null);
  assert.equal(releasedBatches.length, 1);
  assert.equal(releasedBatches[0].length, 32);

  const sentCountBeforeInvalid = sentMethods.length;
  for (const invalid of [
    undefined,
    null,
    {},
    { ids: [] },
    { ids: [...maxBatch, idA] },
    { ids: [idA.toUpperCase()] },
    { ids: [idA.slice(1)] },
    { ids: [idA, 'not-hex'] },
    { ids: [idA], sid: 'spoofed' },
  ]) {
    await assert.rejects(
      media.release(invalid),
      (error) => error instanceof BridgeError && error.code === ErrorCode.InvalidParams,
      `Web helper should reject ${JSON.stringify(invalid)}`,
    );
  }
  // Client-side validation rejected malformed batches without sending wire traffic.
  assert.equal(sentMethods.length, sentCountBeforeInvalid);

  // Bypass Web helper with raw bridge.call to verify Mock host enforces identical atomic validation.
  for (const invalid of [
    {},
    { ids: [] },
    { ids: [...maxBatch, idA] },
    { ids: [idA, idB.toUpperCase()] },
    { ids: [idA], sid: 'another-session' },
  ]) {
    await assert.rejects(
      bridge.call('media.release@1', invalid),
      (error) => error instanceof BridgeError && error.code === ErrorCode.InvalidParams,
      `Mock host should reject ${JSON.stringify(invalid)}`,
    );
  }
  // No invalid batch ever triggered releaseMedia.
  assert.equal(releasedBatches.length, 1);

  bridge.close();
});

test('media.release@1 propagates host -32003 errors and rejects non-null host responses', async () => {
  const deniedAdapter = createMockAdapter({
    releaseMedia: () => {
      throw new HostError(ErrorCode.PermissionDenied, 'Origin denied');
    },
  });
  const deniedBridge = createBridge({ adapter: deniedAdapter });
  const deniedMedia = createMediaHelpers(deniedBridge).media;
  await assert.rejects(
    deniedMedia.release({ ids: [idA] }),
    (error) => error instanceof BridgeError && error.code === ErrorCode.PermissionDenied,
  );
  deniedBridge.close();

  const badResultAdapter = createMockAdapter({
    handlers: {
      'media.release': () => ({ released: [idA] }),
    },
  });
  const badBridge = createBridge({ adapter: badResultAdapter });
  const badMedia = createMediaHelpers(badBridge).media;
  await assert.rejects(
    badMedia.release({ ids: [idA] }),
    (error) => error instanceof BridgeError && error.code === ErrorCode.InternalError,
  );
  badBridge.close();
});
