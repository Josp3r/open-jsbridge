import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { createMockAdapter } from '../dist/packages/web-mock/src/index.js';

const { version, bootstrap, cases } = JSON.parse(readFileSync(
  new URL('./fixtures/host-inbound-raw.json', import.meta.url), 'utf8',
));
assert.equal(version, 1);
assert.ok(cases.length > 0);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

async function verifyStep(adapter, step, state, label) {
  // Walk quoted tokens so an escaped quote inside another string cannot start a placeholder.
  const raw = step.raw.replace(/"(?:[^"\\]|\\[\s\S])*"/g, (token) => {
    if (token !== '"$SID"' && token !== '"$OLD_SID"') return token;
    const sid = token === '"$SID"' ? state.sid : state.oldSid;
    assert.ok(sid, `${label}: unbound ${token}`);
    return JSON.stringify(sid);
  });
  const reply = await adapter.send(raw);
  if (reply === null) {
    assert.ok(step.accept.some(({ kind }) => kind === 'none'), `${label}: unexpected silence; expected ${JSON.stringify(step.accept)}`);
    return;
  }

  const frame = JSON.parse(reply);
  assert.ok(isObject(frame) && frame.jsb === '1.0', `${label}: invalid envelope ${reply}`);
  assert.ok(frame.meta === undefined || isObject(frame.meta), `${label}: invalid meta ${reply}`);
  const { rpc } = frame;
  assert.ok(isObject(rpc) && rpc.jsonrpc === '2.0' && !Object.hasOwn(rpc, 'method'), `${label}: not a response ${reply}`);
  const hasResult = Object.hasOwn(rpc, 'result');
  const hasError = Object.hasOwn(rpc, 'error');
  assert.notEqual(hasResult, hasError, `${label}: expected result or error: ${reply}`);

  const replySid = frame.meta?.sid;
  const expected = step.accept.find((entry) => {
    if (entry.kind === 'none' || !Object.hasOwn(rpc, 'id') || rpc.id !== entry.id) return false;
    if (entry.kind === 'hello') {
      const result = rpc.result;
      return hasResult && isObject(result) && result.jsb === '1.0' &&
        typeof result.sid === 'string' && result.sid.length > 0 &&
        (state.sid === undefined || result.sid === state.sid) &&
        (replySid === undefined || replySid === result.sid);
    }
    const sidMatches = entry.sid === '$SID'
      ? state.sid !== undefined && replySid === state.sid
      : entry.sid === null && replySid === undefined;
    if (!sidMatches) return false;
    if (entry.kind === 'result') return hasResult && isDeepStrictEqual(rpc.result, entry.value);
    return entry.kind === 'error' && hasError && isObject(rpc.error) && rpc.error.code === entry.code &&
      typeof rpc.error.message === 'string' &&
      (!Object.hasOwn(entry, 'data') || isDeepStrictEqual(rpc.error.data, entry.data));
  });
  assert.ok(expected, `${label}: got ${reply}; expected ${JSON.stringify(step.accept)}`);
  if (expected.kind === 'hello') state.sid = rpc.result.sid;
}

for (const { name, initial, steps } of cases) {
  test(`raw host: ${name}`, async () => {
    const adapter = createMockAdapter();
    const state = {};
    assert.ok(['fresh', 'active', 'replaced'].includes(initial));
    if (initial === 'replaced') {
      const previous = {};
      await verifyStep(createMockAdapter(), bootstrap, previous, `${name}: previous bootstrap`);
      state.oldSid = previous.sid;
    }
    if (initial !== 'fresh') {
      await verifyStep(adapter, bootstrap, state, `${name}: bootstrap`);
      assert.notEqual(state.sid, state.oldSid, `${name}: expected a distinct session`);
    }
    for (const [index, step] of steps.entries()) {
      await verifyStep(adapter, step, state, `${name}: step ${index + 1}`);
    }
  });
}
