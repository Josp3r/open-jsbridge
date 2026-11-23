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
