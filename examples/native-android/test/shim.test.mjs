import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../app/src/main/assets/android-transport.js', import.meta.url), 'utf8');

function install({ mainFrame = true, injected = true } = {}) {
  const window = new EventTarget();
  const sent = [];
  const native = new EventTarget();
  native.postMessage = (raw) => sent.push(raw);
  window.top = mainFrame ? window : new EventTarget();
  if (injected) window.__ojsb_wml = native;
  let ready = 0;
  window.addEventListener('ojsb:transportready', () => { ready += 1; });
  vm.runInNewContext(source, { window, crypto: webcrypto, CustomEvent });
  const reply = (data) => native.dispatchEvent(new MessageEvent('message', { data }));
  return { window, sent, reply, ready };
}

test('installs a frozen transport only in a main frame with the native channel', () => {
  const { window, ready } = install();
  const transport = window.__OJSB_TRANSPORT__;
  assert.equal(ready, 1);
  assert.equal(transport.name, 'android-wml');
  assert.deepEqual([...transport.protocols], [1]);
  assert.ok(Object.isFrozen(transport));
  assert.ok(Object.isFrozen(transport.protocols));
  assert.equal(Object.getOwnPropertyDescriptor(window, '__OJSB_TRANSPORT__').configurable, false);
  assert.equal(install({ mainFrame: false }).window.__OJSB_TRANSPORT__, undefined);
  assert.equal(install({ injected: false }).window.__OJSB_TRANSPORT__, undefined);
});

test('holds an early SDK call until Native confirms the active document', () => {
  const { window, sent, reply } = install();
  const raw = '{"jsb":"1.0","rpc":{"jsonrpc":"2.0","id":"hello","method":"bridge.hello"}}';
  assert.equal(window.__OJSB_TRANSPORT__.postMessage(raw), undefined);
  assert.deepEqual(sent, []);
  window.__OJSB_ANDROID_COMMIT__('01000000-0000-0000-0000-000000000000');
  assert.match(sent[0], /^commit:01000000-0000-0000-0000-000000000000:[a-f0-9]{32}$/);
  const token = sent[0].split(':')[2];
  reply('ready:wrong-document');
  assert.equal(sent.length, 1);
  reply(sent[0].replace('commit:', 'ready:'));
  assert.deepEqual(sent.slice(1), [
    'push:01000000-0000-0000-0000-000000000000:' + token,
    'rpc:' + token + ':' + raw,
  ]);
});

test('holds sends during a second confirmation for the same document', () => {
  const { window, sent, reply } = install();
  window.__OJSB_ANDROID_COMMIT__('01000000-0000-0000-0000-000000000000');
  const token = sent[0].split(':')[2];
  const firstChallenge = sent[0].replace('commit:', 'ready:');
  reply(firstChallenge);
  window.__OJSB_ANDROID_COMMIT__('02000000-0000-0000-0000-000000000000');
  window.__OJSB_TRANSPORT__.postMessage('after');
  reply(firstChallenge);
  assert.equal(sent.length, 3);
  reply(sent[2].replace('commit:', 'ready:'));
  assert.equal(sent[3], 'push:02000000-0000-0000-0000-000000000000:' + token);
  assert.equal(sent[4], 'rpc:' + token + ':after');
});

test('flushes replies in order to the SDK receiver and rejects prior document replies after pagehide', () => {
  const { window, sent, reply } = install();
  window.__OJSB_ANDROID_COMMIT__('01000000-0000-0000-0000-000000000000');
  const token = sent[0].split(':')[2];
  const previousReady = sent[0].replace('commit:', 'ready:');
  reply(previousReady);
  reply('rpc:' + token + ':first');
  reply('rpc:' + token + ':second');
  const received = [];
  window.__OJSB_RECEIVE__ = (raw) => received.push(raw);
  assert.deepEqual(received, ['first', 'second']);
  window.dispatchEvent(new Event('pagehide'));
  assert.equal(sent[2], 'leave:' + token);
  reply(previousReady);
  reply('rpc:' + token + ':stale');
  window.__OJSB_ANDROID_COMMIT__('02000000-0000-0000-0000-000000000000');
  const next = sent[3].split(':')[2];
  assert.notEqual(next, token);
  reply(sent[3].replace('commit:', 'ready:'));
  reply('rpc:' + next + ':fresh');
  assert.deepEqual(received, ['first', 'second', 'fresh']);
});
