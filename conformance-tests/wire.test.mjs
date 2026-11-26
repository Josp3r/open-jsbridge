import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  decodeEnvelope,
  encodeEnvelope,
  ErrorCode,
  WireDecodeError,
} from '../dist/packages/protocol/src/index.js';

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const fixtures = readJson('./fixtures/wire.json');
const ajv = new Ajv2020({ allErrors: true, strictRequired: true });
const validate = ajv.compile(readJson('../spec/protocol/envelope.schema.json'));

for (const { name, frame } of fixtures.valid) {
  test(`wire accepts ${name}`, () => {
    assert.equal(validate(frame), true, JSON.stringify(validate.errors));
    assert.deepEqual(decodeEnvelope(JSON.stringify(frame)), frame);
    assert.deepEqual(JSON.parse(encodeEnvelope(frame)), frame);
  });
}

for (const { name, frame, raw, error } of fixtures.invalid) {
  test(`wire rejects ${name}`, () => {
    if (error === ErrorCode.ParseError) {
      assert.throws(() => JSON.parse(raw), SyntaxError);
    } else {
      assert.equal(validate(raw === undefined ? frame : JSON.parse(raw)), false);
    }
    if (raw === undefined) assert.throws(() => encodeEnvelope(frame), { code: error });
    assert.throws(
      () => decodeEnvelope(raw ?? JSON.stringify(frame)),
      (failure) => failure instanceof WireDecodeError && failure.code === error,
    );
  });
}

test('the portable number range applies to nested values throughout the envelope', () => {
  const validNumbers = { items: [-9007199254740991, 9007199254740991, 0.5] };
  const invalidNumbers = { items: [9007199254740992] };
  const request = { jsonrpc: '2.0', id: 'w-1', method: 'conformance.echo' };
  const failure = { jsonrpc: '2.0', id: 'w-1' };
  const frames = [
    ['params', (value) => ({ jsb: '1.0', rpc: { ...request, params: { value } } })],
    ['error data', (value) => ({ jsb: '1.0', rpc: {
      ...failure, error: { code: -32603, message: 'Internal error', data: value },
    } })],
    ['metadata extension', (value) => ({ jsb: '1.0', rpc: request, meta: { extension: value } })],
    ['envelope extension', (value) => ({ jsb: '1.0', rpc: request, extension: value })],
  ];
  for (const [location, makeFrame] of frames) {
    const valid = makeFrame(validNumbers);
    const invalid = makeFrame(invalidNumbers);
    assert.equal(validate(valid), true, location);
    assert.deepEqual(decodeEnvelope(JSON.stringify(valid)), valid, location);
    assert.equal(validate(invalid), false, location);
    assert.throws(() => decodeEnvelope(JSON.stringify(invalid)), { code: ErrorCode.InvalidRequest }, location);
  }
});

test('runtime error codes match the protocol registry', () => {
  const registry = readJson('../spec/protocol/errors.json');
  const codes = Object.fromEntries(Object.entries(registry).map(([name, entry]) => [name, entry.code]));
  assert.deepEqual(ErrorCode, codes);
  assert.equal(new Set(Object.values(codes)).size, Object.keys(codes).length);
});

test('encoding cannot silently replace non-finite results with null', () => {
  assert.throws(() => encodeEnvelope({
    jsb: '1.0', rpc: { jsonrpc: '2.0', id: 'w-1', result: { value: Infinity } },
  }), { code: ErrorCode.InvalidRequest });
});

test('codec works in webviews without Object.hasOwn', () => {
  const { frame } = fixtures.valid[0];
  const original = Object.hasOwn;
  let decoded;
  Object.hasOwn = undefined;
  try {
    decoded = decodeEnvelope(encodeEnvelope(frame));
  } finally {
    Object.hasOwn = original;
  }
  assert.deepEqual(decoded, frame);
});

test('hello fixtures satisfy the method schema', () => {
  const hello = readJson('../spec/methods/bridge/hello.json');
  const request = fixtures.valid.find(({ name }) => name === 'bootstrap hello').frame.rpc;
  const response = fixtures.valid.find(({ name }) => name === 'bootstrap hello response').frame.rpc;
  assert.equal(ajv.compile(hello.params)(request.params), true);
  assert.equal(ajv.compile(hello.result)(response.result), true);
  assert.equal(response.id, request.id);
});

test('echo fixtures satisfy the method schema', () => {
  const echo = readJson('../spec/methods/conformance/echo.json');
  const request = fixtures.valid.find(({ name }) => name === 'forward request with deadline and trace').frame.rpc;
  assert.equal(ajv.compile(echo.params)(request.params), true);
  assert.equal(ajv.compile(echo.result)({ text: '你好' }), true);
});

const nestedRequest = (value) => ({
  jsb: '1.0',
  rpc: { jsonrpc: '2.0', id: 'w-json', method: 'conformance.echo', params: { value } },
});

const cyclic = {};
cyclic.self = cyclic;
for (const [name, value] of [
  ['Date', new Date('2026-01-01T00:00:00.000Z')],
  ['undefined', undefined],
  ['function', () => null],
  ['bigint', 1n],
  ['symbol', Symbol('not a JSON value')],
  ['sparse array', Array(1)],
  ['Map', new Map([['key', 'value']])],
  ['custom serializer', { toJSON() { return 'converted'; } }],
  ['symbol property', { [Symbol('key')]: 'value' }],
  ['array property', Object.assign([null], { key: 'value' })],
  ['cyclic object', cyclic],
  ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
]) {
  test(`encoding rejects a nested ${name}`, () => {
    const before = (error) => error instanceof WireDecodeError && error.code === ErrorCode.InvalidRequest;
    assert.throws(() => encodeEnvelope(nestedRequest({ value })), before);
  });
}

test('encoding reads JSON data without executing accessors or custom serializers', () => {
  let calls = 0;
  const value = {
    get field() { calls++; return 'value'; },
    toJSON() { calls++; return null; },
  };
  assert.throws(() => encodeEnvelope(nestedRequest(value)), { code: ErrorCode.InvalidRequest });
  assert.equal(calls, 0);
});

test('nested plain JSON including shared references survives encode and decode', () => {
  const shared = { absent: null, truth: false, count: 2.25 };
  const value = { items: [shared, shared, null, ['text']], toJSON: 'ordinary JSON field' };
  const frame = nestedRequest(value);
  assert.deepEqual(decodeEnvelope(encodeEnvelope(frame)), frame);
});

test('decoding drops __proto__ but preserves nested business fields', () => {
  const record = Object.fromEntries([
    ['label', 'keep'],
    ['__proto__', 'reserved name'],
    ['constructor', { name: 'business data' }],
    ['prototype', { available: true }],
  ]);
  const frame = nestedRequest({ items: [record] });
  const expected = nestedRequest({
    items: [{ label: 'keep', constructor: { name: 'business data' }, prototype: { available: true } }],
  });
  assert.deepEqual(decodeEnvelope(JSON.stringify(frame)), expected);
  const badNumber = nestedRequest({ constructor: Number.MAX_SAFE_INTEGER + 1 });
  assert.throws(() => decodeEnvelope(JSON.stringify(badNumber)), { code: -32600 });
});
