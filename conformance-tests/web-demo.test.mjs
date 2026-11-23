import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';

function demoPage(t, search) {
  const elements = new Map();
  const window = Object.assign(new EventTarget(), { location: { search } });
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) {
        elements.set(selector, Object.assign(new EventTarget(), { dataset: {}, setAttribute() {} }));
      }
      return elements.get(selector);
    },
  };
  Object.assign(globalThis, { document, window });
  t.after(() => {
    delete globalThis.document;
    delete globalThis.window;
  });
  return { window, element: document.querySelector };
}

test('native-mode demo does not hide a missing host by installing Mock', async (t) => {
  const { window } = demoPage(t, '?host=native');
  await import('../examples/web-demo/demo.js?no-native-host');
  assert.equal(window.__OJSB_TRANSPORT__, undefined);
});

test('shared demo sends its first call through the injected Native transport', async (t) => {
  const { window, element } = demoPage(t, '?host=native');
  const { createMockAdapter } = await import('../dist/packages/web-mock/src/index.js');
  const adapter = createMockAdapter();
  const methods = [];
  const transport = Object.freeze({
    name: 'ios-wk',
    protocols: [1],
    async postMessage(raw) {
      const method = JSON.parse(raw).rpc.method;
      methods.push(method);
      const reply = await adapter.send(raw);
      if (method !== 'bridge.hello') return reply;
      const response = JSON.parse(reply);
      response.rpc.result.host = { platform: 'ios', name: 'ios-wk', version: '0.1.0' };
      return JSON.stringify(response);
    },
  });
  Object.defineProperty(window, '__OJSB_TRANSPORT__', { value: transport });
  const expected = { text: '你好' };
  element('#message').value = expected.text;

  await import('../examples/web-demo/demo.js?native-host');
  element('#echo-form').dispatchEvent(new Event('submit', { cancelable: true }));
  await setImmediate();

  assert.equal(window.__OJSB_TRANSPORT__, transport);
  assert.deepEqual(methods, ['bridge.hello', 'conformance.echo']);
  assert.deepEqual(JSON.parse(element('#result').textContent), expected);
  assert.equal(element('#connection-status').dataset.platform, 'ios');
});
