import assert from 'node:assert/strict';
import { test } from 'node:test';

const mockModule = '../dist/packages/web-mock/src/index.js';
const echo = 'conformance.echo';
const readyEvent = 'ojsb:transportready';

function browserWindow(t) {
  const window = new EventTarget();
  const needsCustomEvent = typeof CustomEvent === 'undefined';
  if (needsCustomEvent) globalThis.CustomEvent = class CustomEvent extends Event {};
  Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
  t.after(() => {
    delete globalThis.window;
    if (needsCustomEvent) delete globalThis.CustomEvent;
  });
  return window;
}

test('browser Mock import leaves the transport slot untouched until explicit installation', async (t) => {
  const window = browserWindow(t);
  const events = [];
  window.addEventListener(readyEvent, (event) => {
    events.push({ event, transport: window.__OJSB_TRANSPORT__ });
  });
  const { installMockTransport } = await import(`${mockModule}?explicit`);
  assert.equal(Object.hasOwn(window, '__OJSB_TRANSPORT__'), false);
  assert.deepEqual(events, []);
  assert.equal(typeof installMockTransport, 'function');

  installMockTransport();

  const descriptor = Object.getOwnPropertyDescriptor(window, '__OJSB_TRANSPORT__');
  assert.equal(descriptor.writable, false);
  assert.equal(descriptor.configurable, false);
  assert.equal(descriptor.value.name, 'mock');
  assert.equal(Object.isFrozen(descriptor.value), true);
  assert.equal(Object.isFrozen(descriptor.value.protocols), true);
  assert.deepEqual(descriptor.value.protocols, [1]);
  assert.equal(events.length, 1);
  assert.ok(events[0].event instanceof CustomEvent);
  assert.equal(events[0].transport, descriptor.value);
});

test('the default bridge negotiates and echoes through the preinstalled Mock transport', async (t) => {
  browserWindow(t);
  const { installMockTransport } = await import(mockModule);
  const frames = [];
  installMockTransport({ onFrame: (direction, raw) => frames.push([direction, JSON.parse(raw)]) });
  const { bridge } = await import('../dist/packages/web-sdk/src/index.js?preinstalled-mock');
  const payload = { text: '你好', values: [1, null, true] };

  assert.deepEqual(await bridge.call(echo, payload), payload);
  assert.equal(bridge.host.platform, 'mock');
  assert.equal(bridge.has(echo, 1), true);
  assert.deepEqual(frames.map(([direction]) => direction), ['request', 'response', 'request', 'response']);
  const [, hello] = frames[0];
  const [, helloReply] = frames[1];
  const [, request] = frames[2];
  const [, response] = frames[3];
  assert.equal(hello.rpc.method, 'bridge.hello');
  assert.equal(helloReply.rpc.id, hello.rpc.id);
  assert.equal(request.meta.sid, helloReply.rpc.result.sid);
  assert.equal(request.rpc.method, echo);
  assert.deepEqual(request.rpc.params, payload);
  assert.equal(response.rpc.id, request.rpc.id);
  assert.deepEqual(response.rpc.result, payload);
});

test('the default bridge sends its queued first call after Mock dispatches transportready', async (t) => {
  const window = browserWindow(t);
  const { installMockTransport } = await import(mockModule);
  assert.equal(typeof installMockTransport, 'function');
  const { bridge } = await import('../dist/packages/web-sdk/src/index.js?late-mock');
  const pending = bridge.call(echo, { text: 'first call' });

  assert.equal(bridge.state, 'connecting');
  assert.equal(window.__OJSB_TRANSPORT__, undefined);
  installMockTransport();

  assert.deepEqual(await pending, { text: 'first call' });
  assert.equal(bridge.state, 'ready');
});

test('Mock installation preserves an existing host transport', async (t) => {
  const window = browserWindow(t);
  const { installMockTransport } = await import(mockModule);
  const host = { name: 'native', protocols: [1], postMessage() {} };
  window.__OJSB_TRANSPORT__ = host;
  const descriptor = Object.getOwnPropertyDescriptor(window, '__OJSB_TRANSPORT__');
  let readyCount = 0;
  window.addEventListener(readyEvent, () => { readyCount++; });

  installMockTransport();

  assert.equal(window.__OJSB_TRANSPORT__, host);
  assert.deepEqual(Object.getOwnPropertyDescriptor(window, '__OJSB_TRANSPORT__'), descriptor);
  assert.equal(readyCount, 0);
});

test('reinstalling Mock keeps its original frame observer and the observer cannot interrupt replies', async (t) => {
  const window = browserWindow(t);
  const { installMockTransport } = await import(mockModule);
  let readyCount = 0;
  window.addEventListener(readyEvent, () => { readyCount++; });
  const frames = [];
  installMockTransport({
    onFrame(direction, raw) {
      frames.push([direction, raw]);
      throw new Error('observer failed');
    },
  });
  const transport = window.__OJSB_TRANSPORT__;
  const replacementFrames = [];
  installMockTransport({ onFrame: (...frame) => replacementFrames.push(frame) });

  assert.equal(window.__OJSB_TRANSPORT__, transport);
  assert.equal(readyCount, 1);
  const reply = transport.postMessage('{');
  assert.ok(reply instanceof Promise);
  assert.equal(await reply, null);
  assert.deepEqual(frames, [['request', '{'], ['response', null]]);
  assert.deepEqual(replacementFrames, []);
});
