import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { loadSpecBundle } from '../scripts/codegen.mjs';

const id = '0123456789abcdef0123456789abcdef';
let acceptsParams;
let acceptsResult;

before(() => {
  const { methods, schemas } = loadSpecBundle();
  const release = methods.find(({ document }) =>
    document.title === 'media.release' && document['x-ojsb-version'] === 1);
  assert.ok(release, 'media.release@1 must have a method contract');
  const ajv = new Ajv2020({ schemas: schemas.map(({ document }) => document) });
  acceptsParams = ajv.compile(release.document.params);
  acceptsResult = ajv.compile(release.document.result);
});

test('release accepts one through 32 media handles, including repeated IDs', () => {
  const batch = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(32, '0'));
  assert.ok(acceptsParams({ ids: [id] }));
  assert.ok(acceptsParams({ ids: [id, id] }));
  assert.ok(acceptsParams({ ids: batch }));
  assert.equal(acceptsParams({ ids: [] }), false);
  assert.equal(acceptsParams({ ids: [...batch, id] }), false);
});

test('release requires a batch of valid handles and rejects a caller-supplied session', () => {
  for (const invalid of [
    {}, null, [id], { ids: id }, { ids: [id, null] },
    { ids: [id, id.toUpperCase()] }, { ids: [id.slice(1)] }, { ids: [id + '0'] },
    { ids: [id], sid: 'another-document' },
  ]) {
    assert.equal(acceptsParams(invalid), false, JSON.stringify(invalid));
  }
});

test('release acknowledges success with null and discloses no per-handle status', () => {
  assert.ok(acceptsResult(null));
  for (const invalid of [{}, true, 0, [id], { released: [id] }, { missing: [id] }]) {
    assert.equal(acceptsResult(invalid), false, JSON.stringify(invalid));
  }
});
