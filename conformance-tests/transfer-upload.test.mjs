import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { loadSpecBundle } from '../scripts/codegen.mjs';
import { ErrorCode } from '../dist/packages/protocol/src/index.js';
import { createMockAdapter } from '../dist/packages/web-mock/src/index.js';
import { BridgeError, createBridge } from '../dist/packages/web-sdk/src/index.js';
import { createTransferHelpers } from '../dist/packages/web-sdk/src/transfer.js';

const mediaId = '0123456789abcdef0123456789abcdef';
const endpoint = 'https://uploads.example.com/v1/avatar';

let acceptsParams;
let acceptsResult;
let acceptsProgress;

before(() => {
  const { methods, schemas } = loadSpecBundle();
  const upload = methods.find(({ document }) =>
    document.title === 'transfer.upload' && document['x-ojsb-version'] === 1);
  assert.ok(upload, 'transfer.upload@1 must have a method contract');
  assert.equal(upload.document['x-ojsb-concurrency'], 'serial');
  assert.equal(upload.document['x-ojsb-concurrency-policy'], 'reject');
  assert.ok(upload.document['x-ojsb-callbacks']);

  const ajv = new Ajv2020({ schemas: schemas.map(({ document }) => document) });
  acceptsParams = ajv.compile(upload.document.params);
  acceptsResult = ajv.compile(upload.document.result);
  acceptsProgress = ajv.compile(upload.document['x-ojsb-callbacks']);
});

test('transfer.upload@1 schema validates params, results, and progress chunks per RFC', () => {
  assert.ok(acceptsParams({ id: mediaId, request: { url: endpoint } }));
  assert.ok(acceptsParams({
    id: mediaId,
    request: {
      url: endpoint,
      method: 'POST',
      fieldName: 'avatar_file',
      formData: { purpose: 'avatar' },
      headers: { 'X-Client-Trace': 'abc' },
      compress: { maxEdge: 1600, quality: 80 },
    },
  }));

  for (const invalid of [
    {},
    { id: mediaId },
    { id: 'bad', request: { url: endpoint } },
    { id: mediaId, request: { url: 'http://uploads.example.com/v1/avatar' } },
    { id: mediaId, request: { url: endpoint, method: 'PUT' } },
    { id: mediaId, request: { url: endpoint, timeout: 5000 } },
    { id: mediaId, request: { url: endpoint, fieldName: 'bad field' } },
    { id: mediaId, request: { url: endpoint, headers: { 'X-Test': 'line1\r\nline2' } } },
    { id: mediaId, request: { url: endpoint, compress: { maxEdge: 4097 } } },
    { id: mediaId, request: { url: endpoint, compress: { quality: 0 } } },
  ]) {
    assert.equal(acceptsParams(invalid), false, `Schema should reject ${JSON.stringify(invalid)}`);
  }

  assert.ok(acceptsResult({ status: 201, body: '{"assetId":"avatar-42"}' }));
  assert.ok(acceptsResult({ status: 204, body: '' }));
  assert.ok(acceptsResult({ status: 413, body: 'too large' }));
  for (const invalid of [
    { status: 99, body: '' },
    { status: 600, body: '' },
    { status: 200 },
    { status: 200, body: '', headers: {} },
  ]) {
    assert.equal(acceptsResult(invalid), false);
  }

  assert.ok(acceptsProgress({ sent: 0, total: 1024 }));
  assert.ok(acceptsProgress({ sent: 1024, total: 1024 }));
  assert.equal(acceptsProgress({ sent: -1, total: 1024 }), false);
  assert.equal(acceptsProgress({ sent: 0, total: 0 }), false);
});

test('transfer.upload@1 streams monotonic progress, supports idleTimeout, and preserves HTTP status/body', async () => {
  let responseToReturn = { status: 201, body: '{"assetId":"avatar-42"}' };
  const adapter = createMockAdapter({
    supportsCancel: true,
    supportsCallbacks: true,
    allowedUploadUrls: [endpoint],
    uploadMedia: async (_params, ctx) => {
      ctx.callback({ sent: 0, total: 100 });
      await new Promise((r) => setTimeout(r, 25));
      // Emit a valid chunk, an out-of-range chunk (ignored), a regressive chunk (ignored), and final chunk.
      ctx.callback({ sent: 50, total: 100 });
      ctx.callback({ sent: 150, total: 100 });
      ctx.callback({ sent: 40, total: 100 });
      ctx.callback({ sent: 50, total: 200 });
      await new Promise((r) => setTimeout(r, 25));
      ctx.callback({ sent: 100, total: 100 });
      return responseToReturn;
    },
  });

  const bridge = createBridge({ adapter });
  const { transfer } = createTransferHelpers(bridge);
  await bridge.ready();
  assert.equal(bridge.has('transfer.upload', 1), true);

  const progress = [];
  const res201 = await transfer.upload(
    {
      id: mediaId,
      request: {
        url: endpoint,
        fieldName: 'file',
        formData: { purpose: 'avatar' },
        headers: { 'X-Custom': 'yes' },
        compress: { maxEdge: 1600, quality: 80 },
      },
    },
    {
      timeout: 45,
      idleTimeout: true,
      onProgress: (chunk) => progress.push(chunk),
    },
  );
  assert.deepEqual(res201, { status: 201, body: '{"assetId":"avatar-42"}' });
  assert.deepEqual(progress, [
    { sent: 0, total: 100 },
    { sent: 50, total: 100 },
    { sent: 100, total: 100 },
  ]);

  // 204 empty body & 413 error body are delivered as normal HTTP results.
  responseToReturn = { status: 204, body: '' };
  assert.deepEqual(await transfer.upload({ id: mediaId, request: { url: endpoint } }), { status: 204, body: '' });

  responseToReturn = { status: 413, body: 'file too big' };
  assert.deepEqual(
    await transfer.upload({ id: mediaId, request: { url: endpoint } }),
    { status: 413, body: 'file too big' },
  );

  bridge.close();
});

test('transfer.upload@1 enforces serial concurrency (-32010) and AbortSignal cancellation (-32002)', async () => {
  let abortedOnHost = false;
  let releaseUpload;
  const adapter = createMockAdapter({
    supportsCancel: true,
    supportsCallbacks: true,
    uploadMedia: (_params, ctx) => new Promise((resolve) => {
      ctx.signal.addEventListener('abort', () => {
        abortedOnHost = true;
        resolve({ status: 200, body: '' });
      }, { once: true });
      releaseUpload = () => resolve({ status: 200, body: 'ok' });
    }),
  });

  const bridge = createBridge({ adapter });
  const { transfer } = createTransferHelpers(bridge);
  await bridge.ready();

  const controller = new AbortController();
  const first = transfer.upload({ id: mediaId, request: { url: endpoint } }, { signal: controller.signal });
  await new Promise((r) => setTimeout(r, 10));

  // Second concurrent upload is rejected with Busy (-32010).
  await assert.rejects(
    transfer.upload({ id: mediaId, request: { url: endpoint } }),
    (error) => error instanceof BridgeError && error.code === ErrorCode.Busy,
  );

  // Aborting first cancels it and releases the serial slot.
  controller.abort();
  await assert.rejects(
    first,
    (error) => error instanceof BridgeError && error.code === ErrorCode.Cancelled,
  );
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(abortedOnHost, true);

  // Subsequent upload succeeds once the serial slot is free.
  const second = transfer.upload({ id: mediaId, request: { url: endpoint } });
  await new Promise((r) => setTimeout(r, 10));
  releaseUpload();
  assert.deepEqual(await second, { status: 200, body: 'ok' });

  bridge.close();
});

test('transfer.upload@1 rejects invalid params (-32602), budget overflows (-32006), and forbidden headers/endpoints (-32003) before upload', async () => {
  let uploadCalls = 0;
  let bigBody = false;
  const adapter = createMockAdapter({
    allowedUploadUrls: [endpoint],
    uploadMedia: () => {
      uploadCalls += 1;
      return { status: 200, body: bigBody ? 'x'.repeat(32 * 1024 + 1) : 'ok' };
    },
  });

  const bridge = createBridge({ adapter });
  const { transfer } = createTransferHelpers(bridge);
  await bridge.ready();

  // Client-side validation (-32602)
  await assert.rejects(
    transfer.upload({ id: mediaId, request: { url: endpoint } }, { timeout: 0 }),
    { code: ErrorCode.InvalidParams },
  );
  await assert.rejects(
    transfer.upload({ id: mediaId, request: { url: `${endpoint}?q=1` } }),
    { code: ErrorCode.InvalidParams },
  );
  await assert.rejects(
    transfer.upload({ id: mediaId, request: { url: endpoint, fieldName: 'photo', formData: { photo: 'dup' } } }),
    { code: ErrorCode.InvalidParams },
  );
  await assert.rejects(
    transfer.upload({ id: mediaId, request: { url: endpoint, headers: { 'X-A': '1', 'x-a': '2' } } }),
    { code: ErrorCode.InvalidParams },
  );

  // Metadata budgets (-32006)
  const seventeenFields = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v']));
  await assert.rejects(
    transfer.upload({ id: mediaId, request: { url: endpoint, formData: seventeenFields } }),
    { code: ErrorCode.PayloadTooLarge },
  );
  await assert.rejects(
    transfer.upload({ id: mediaId, request: { url: endpoint, formData: { big: 'a'.repeat(16 * 1024) } } }),
    { code: ErrorCode.PayloadTooLarge },
  );

  // Host-side authorization boundaries (-32003) — zero uploadMedia calls!
  for (const forbidden of [
    { Authorization: 'Bearer secret' },
    { Cookie: 'sid=1' },
    { Host: 'evil.example.com' },
    { 'Content-Type': 'text/plain' },
    { 'Transfer-Encoding': 'chunked' },
  ]) {
    await assert.rejects(
      transfer.upload({ id: mediaId, request: { url: endpoint, headers: forbidden } }),
      (error) => error instanceof BridgeError && error.code === ErrorCode.PermissionDenied,
    );
  }

  // Same-origin different path is not allowed unless explicitly configured.
  await assert.rejects(
    transfer.upload({ id: mediaId, request: { url: 'https://uploads.example.com/v1/other' } }),
    (error) => error instanceof BridgeError && error.code === ErrorCode.PermissionDenied,
  );
  assert.equal(uploadCalls, 0);

  // Oversized response body (> 32 KiB) returns -32006.
  bigBody = true;
  await assert.rejects(
    transfer.upload({ id: mediaId, request: { url: endpoint } }),
    (error) => error instanceof BridgeError && error.code === ErrorCode.PayloadTooLarge,
  );
  assert.equal(uploadCalls, 1);

  bridge.close();
});
