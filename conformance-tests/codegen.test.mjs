import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateTypeScript, lintSpecBundle } from '../dist/packages/codegen/src/index.js';
import { loadSpecBundle, validateSpecSchemasWithAjv } from '../scripts/codegen.mjs';

const generatedSpecPath = fileURLToPath(new URL('../packages/web-sdk/src/generated/spec.ts', import.meta.url));

function baseBundle() {
  return {
    schemas: [
      {
        path: 'schemas/sample-item.json',
        document: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          $id: 'ojsb:schema/sample.item',
          title: 'SampleItem',
          type: 'object',
          required: ['id'],
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
          },
        },
      },
    ],
    methods: [
      {
        path: 'methods/sample/get.json',
        document: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          $id: 'ojsb:method/sample.get',
          title: 'sample.get',
          description: 'Fetch a sample item.',
          'x-ojsb-kind': 'method',
          'x-ojsb-version': 1,
          'x-ojsb-since': '1.0',
          params: { type: 'object', maxProperties: 0 },
          result: { $ref: 'ojsb:schema/sample.item' },
        },
      },
    ],
    errors: {
      path: 'protocol/errors.json',
      document: {
        ParseError: { code: -32700, message: 'Parse error' },
        Timeout: { code: -32001, message: 'Timeout' },
      },
    },
  };
}

test('repository spec/ passes rule lint and Ajv 2020-12 schema compilation', () => {
  const bundle = loadSpecBundle();
  assert.deepEqual(lintSpecBundle(bundle), []);
  assert.deepEqual(validateSpecSchemasWithAjv(bundle), []);
});

test('checked-in packages/web-sdk/src/generated/spec.ts matches spec/ output', () => {
  const bundle = loadSpecBundle();
  const expected = generateTypeScript(bundle);
  const actual = readFileSync(generatedSpecPath, 'utf8');
  assert.equal(actual, expected, 'Run `npm run codegen:ts` to synchronize generated TypeScript types');
});

test('spec linter rejects reserved rpc.* namespace and malformed names', () => {
  const bundle = baseBundle();
  bundle.methods[0].path = 'methods/rpc/ping.json';
  bundle.methods[0].document.$id = 'ojsb:method/rpc.ping';
  bundle.methods[0].document.title = 'rpc.ping';

  const issues = lintSpecBundle(bundle);
  assert.ok(issues.some((issue) => issue.rule === 'name'));
});

test('spec linter rejects path/version/$id mismatches and duplicate versions', () => {
  const bundle = baseBundle();
  bundle.methods.push({
    path: 'methods/sample/wrongName.json',
    document: {
      ...bundle.methods[0].document,
      $id: 'ojsb:method/sample.get@99',
    },
  });

  const issues = lintSpecBundle(bundle);
  assert.ok(issues.some((issue) => issue.rule === 'spec-id'));
  assert.ok(issues.some((issue) => issue.rule === 'spec-path'));
  assert.ok(issues.some((issue) => issue.rule === 'duplicate-version'));
});

test('spec linter rejects unresolved $ref, unknown x-ojsb-* keywords, and invalid business error codes', () => {
  const bundle = baseBundle();
  bundle.methods[0].document.result = { $ref: 'ojsb:schema/does.notExist' };
  bundle.methods[0].document['x-ojsb-unknown'] = true;
  bundle.methods[0].document['x-ojsb-errors'] = [-32001, 100000];

  const issues = lintSpecBundle(bundle);
  assert.ok(issues.some((issue) => issue.rule === 'ref-target'));
  assert.ok(issues.some((issue) => issue.rule === 'unknown-extension'));
  assert.ok(issues.some((issue) => issue.rule === 'extension-errors'));
});

test('spec linter rejects invalid method/event payload combinations', () => {
  const bundle = baseBundle();
  bundle.methods[0].document.payload = { type: 'null' };
  bundle.methods.push({
    path: 'methods/sample/updated.json',
    document: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'ojsb:event/sample.updated',
      title: 'sample.updated',
      description: 'Sample updated.',
      'x-ojsb-kind': 'event',
      'x-ojsb-version': 1,
      'x-ojsb-since': '1.0',
      params: { type: 'object' },
    },
  });

  const issues = lintSpecBundle(bundle);
  assert.ok(issues.some((issue) => issue.rule === 'method-no-payload'));
  assert.ok(issues.some((issue) => issue.rule === 'event-payload'));
  assert.ok(issues.some((issue) => issue.rule === 'event-no-rpc-fields'));
});

test('spec linter rejects duplicate and out-of-range protocol error codes', () => {
  const bundle = baseBundle();
  bundle.errors.document = {
    ParseError: { code: -32700, message: 'Parse error' },
    DuplicateParseError: { code: -32700, message: 'Duplicate' },
    InvalidNegative: { code: -500, message: 'Disallowed negative code' },
  };

  const issues = lintSpecBundle(bundle);
  assert.ok(issues.some((issue) => issue.rule === 'errors-duplicate-code'));
  assert.ok(issues.some((issue) => issue.rule === 'errors-range'));
});

test('TypeScript emitter handles multi-version methods, unions, intersections, and refs', () => {
  const bundle = baseBundle();
  bundle.methods.push({
    path: 'methods/sample/get@2.json',
    document: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'ojsb:method/sample.get@2',
      title: 'sample.get',
      description: 'Fetch sample item v2.',
      'x-ojsb-kind': 'method',
      'x-ojsb-version': 2,
      'x-ojsb-since': '1.0',
      params: {
        type: 'object',
        properties: {
          mode: { enum: ['fast', 'full'] },
        },
        additionalProperties: false,
      },
      result: {
        oneOf: [
          {
            type: 'object',
            required: ['status', 'item'],
            properties: {
              status: { const: 'ok' },
              item: { $ref: 'ojsb:schema/sample.item' },
            },
          },
          {
            type: 'object',
            required: ['status'],
            properties: {
              status: { const: 'empty' },
            },
          },
        ],
      },
    },
  });

  assert.deepEqual(lintSpecBundle(bundle), []);
  const output = generateTypeScript(bundle);
  assert.match(output, /export interface SampleItem \{/);
  assert.match(output, /export interface SampleGetV2Params \{/);
  assert.match(output, /export type SampleGetV2Result = \{/);
  assert.match(output, /"sample\.get": \{ params: SampleGetParams; result: SampleGetResult \};/);
  assert.match(output, /"sample\.get@2": \{ params: SampleGetV2Params; result: SampleGetV2Result \};/);
  assert.match(output, /readonly Timeout: -32001;/);
});
