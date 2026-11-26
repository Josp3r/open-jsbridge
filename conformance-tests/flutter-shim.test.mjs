import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const shimSource = readFileSync(
  new URL('../packages/flutter/lib/src/shim.dart', import.meta.url),
  'utf8',
);

function extractInAppShim() {
  const match = shimSource.match(/const String ojsbInAppWebViewShim = r'''([\s\S]*?)''';/);
  assert.ok(match, 'Expected ojsbInAppWebViewShim in packages/flutter/lib/src/shim.dart');
  return match[1];
}

function extractWebviewFlutterShim(channelName = 'OjsbChannel') {
  const match = shimSource.match(/return '''([\s\S]*?)''';/);
  assert.ok(match, 'Expected buildWebviewFlutterShim template in packages/flutter/lib/src/shim.dart');
  return match[1].replaceAll('$channelName', channelName);
}

function createWindowHarness(extras = {}) {
  const listeners = new Map();
  const dispatched = [];
  const errors = [];
  const win = {
    ...extras,
    addEventListener(type, fn) {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent(event) {
      dispatched.push(event);
      for (const fn of [...(listeners.get(event.type) ?? [])]) fn(event);
    },
  };
  win.top = extras.top ?? win;
  return {
    window: win,
    dispatched,
    errors,
    run(script) {
      runInNewContext(script, {
        window: win,
        CustomEvent: class {
          constructor(type) { this.type = type; }
        },
        Promise,
        setTimeout: (fn) => errors.push(fn),
      });
    },
  };
}

test('InAppWebView shim installs frozen transport, buffers messages, and dispatches ready', async () => {
  const calls = [];
  const harness = createWindowHarness({
    flutter_inappwebview: {
      callHandler(name, payload) {
        calls.push([name, payload]);
        return Promise.resolve('{"reply":true}');
      },
    },
  });
  harness.run(extractInAppShim());

  const { window, dispatched, errors } = harness;
  assert.equal(dispatched.some((e) => e.type === 'ojsb:transportready'), true);
  assert.equal(Object.isFrozen(window.__OJSB_TRANSPORT__), true);
  assert.equal(Object.isFrozen(window.__OJSB_TRANSPORT__.protocols), true);
  assert.equal(window.__OJSB_TRANSPORT__.name, 'flutter');
  assert.deepEqual([...window.__OJSB_TRANSPORT__.protocols], [1]);

  const reply = await window.__OJSB_TRANSPORT__.postMessage('{"jsb":"1.0"}');
  assert.equal(reply, '{"reply":true}');
  assert.deepEqual(calls, [['ojsb', '{"jsb":"1.0"}']]);

  window.__OJSB_RECEIVE__('first');
  window.__OJSB_RECEIVE__ = undefined;
  window.__OJSB_RECEIVE__('second');
  assert.equal(errors.length, 0);

  const received = [];
  window.__OJSB_RECEIVE__ = (msg) => {
    if (msg === 'first') throw new Error('boom');
    received.push(msg);
  };
  assert.deepEqual(received, ['second']);
  assert.equal(errors.length, 1);
});

test('InAppWebView shim waits for flutterInAppWebViewPlatformReady when callHandler is not ready yet', async () => {
  const harness = createWindowHarness();
  harness.run(extractInAppShim());

  const pending = harness.window.__OJSB_TRANSPORT__.postMessage('{"early":true}');
  const calls = [];
  harness.window.flutter_inappwebview = {
    callHandler(name, payload) {
      calls.push([name, payload]);
      return Promise.resolve('{"ready":true}');
    },
  };
  harness.window.dispatchEvent({ type: 'flutterInAppWebViewPlatformReady' });

  assert.equal(await pending, '{"ready":true}');
  assert.deepEqual(calls, [['ojsb', '{"early":true}']]);
});

test('InAppWebView and webview_flutter shims refuse to install inside subframes', () => {
  const parent = {};
  const inAppHarness = createWindowHarness({ top: parent });
  inAppHarness.run(extractInAppShim());
  assert.equal(inAppHarness.window.__OJSB_TRANSPORT__, undefined);

  const wfHarness = createWindowHarness({
    top: parent,
    OjsbChannel: { postMessage() {} },
  });
  wfHarness.run(extractWebviewFlutterShim());
  assert.equal(wfHarness.window.__OJSB_TRANSPORT__, undefined);
});

test('webview_flutter shim posts via OjsbChannel and returns undefined', () => {
  const posted = [];
  const harness = createWindowHarness({
    OjsbChannel: {
      postMessage(raw) { posted.push(raw); },
    },
  });
  harness.run(extractWebviewFlutterShim());

  const { window } = harness;
  assert.equal(Object.isFrozen(window.__OJSB_TRANSPORT__), true);
  assert.equal(window.__OJSB_TRANSPORT__.name, 'flutter');
  assert.equal(window.__OJSB_TRANSPORT__.postMessage('{"jsb":"1.0"}'), undefined);
  assert.deepEqual(posted, ['{"jsb":"1.0"}']);
});
