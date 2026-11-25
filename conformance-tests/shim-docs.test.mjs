import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

function loadShim(document) {
  const source = readFileSync(new URL(`../docs/${document}.md`, import.meta.url), 'utf8');
  const snippet = [...source.matchAll(/^```js\n([\s\S]*?)^```$/gm)]
    .find(([, script]) => script.includes("Object.defineProperty(window, '__OJSB_RECEIVE__'"))?.[1];
  assert.ok(snippet, `Expected a shim example in ${document}.md`);
  const errors = [];
  const window = {
    webkit: { messageHandlers: { ojsb: {} } },
    __ojsb_wml: { addEventListener() {} },
    dispatchEvent() {},
  };
  window.top = window;
  runInNewContext(snippet, {
    window,
    CustomEvent: class {},
    setTimeout: (report) => errors.push(report),
  });
  return { window, errors };
}

for (const document of ['native-ios', 'native-android', 'flutter']) {
  test(`${document} shim keeps buffered messages when a receiver is cleared`, () => {
    const { window, errors } = loadShim(document);
    window.__OJSB_RECEIVE__('before clear');
    window.__OJSB_RECEIVE__ = undefined;
    window.__OJSB_RECEIVE__('after clear');
    assert.equal(errors.length, 0);

    const received = [];
    window.__OJSB_RECEIVE__ = (message) => received.push(message);
    assert.deepEqual(received, ['before clear', 'after clear']);
  });

  test(`${document} shim keeps draining after a receiver throws`, () => {
    const { window } = loadShim(document);
    window.__OJSB_RECEIVE__('first');
    window.__OJSB_RECEIVE__('second');
    const received = [];
    window.__OJSB_RECEIVE__ = (message) => {
      if (message === 'first') throw new Error('receiver exception');
      received.push(message);
    };

    assert.deepEqual(received, ['second']);
  });
}
