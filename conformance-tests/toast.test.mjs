import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { bridge } from '../dist/packages/web-sdk/src/auto.js';
import { createBridge, ErrorCode } from '../dist/packages/web-sdk/src/index.js';
import { createMockAdapter, installMockTransport } from '../dist/packages/web-mock/src/index.js';

const method = 'ui.toast.show';
const maxText = '👋'.repeat(120);
const invalidParams = [{}, { text: '' }, { text: 2 }, { text: maxText + '!' }, { text: 'hi', extra: true }];

test('Toast v1 publishes a precise parameter and acknowledgement schema', () => {
  const contract = JSON.parse(readFileSync(new URL('../spec/methods/ui/toast/show.json', import.meta.url), 'utf8'));
  const ajv = new Ajv2020({ strictRequired: true });
  const validateParams = ajv.compile(contract.params);
  const validateResult = ajv.compile(contract.result);
  assert.equal(contract['x-ojsb-version'], 1);
  assert.ok(validateParams({ text: maxText }));
  for (const params of invalidParams) assert.equal(validateParams(params), false);
  assert.ok(validateResult({}));
  assert.equal(validateResult({ shown: true }), false);
});

test('the Mock host advertises and dispatches Toast only after opt-in', async () => {
  const disabled = createBridge({ adapter: createMockAdapter() });
  await disabled.ready();
  assert.equal(disabled.has(method), false);
  await assert.rejects(disabled.call(method, { text: 'hi' }), { code: ErrorCode.MethodNotFound });

  const shown = [];
  const enabled = createBridge({ adapter: createMockAdapter({ showToast: (text) => shown.push(text) }) });
  await enabled.ready();
  assert.equal(enabled.has(method, 1), true);
  assert.deepEqual(await enabled.call(method + '@1', { text: maxText }), {});
  for (const params of [undefined, ...invalidParams]) {
    await assert.rejects(enabled.call(method, params), { code: ErrorCode.InvalidParams });
  }
  assert.deepEqual(shown, [maxText]);
});

test('the typed Toast helper calls through the page default bridge', async (t) => {
  const { ui } = await import('../dist/packages/web-sdk/src/auto.js');
  Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true });
  t.after(() => { delete globalThis.window; });
  const shown = [];
  installMockTransport({ showToast: (text) => shown.push(text) });

  assert.deepEqual(await ui.toast.show({ text: 'Saved' }), {});
  assert.equal(bridge.state, 'ready');
  assert.deepEqual(shown, ['Saved']);
});

test('the Mock reports an asynchronous presenter failure as a correlated error', async () => {
  const client = createBridge({ adapter: createMockAdapter({
    async showToast() { throw new Error('Presenter unavailable'); },
  }) });
  await assert.rejects(client.call(method, { text: 'Saved' }), { code: ErrorCode.InternalError });
});
