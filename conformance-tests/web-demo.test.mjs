import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

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

test('shared demo uses the injected Native transport for calls and events', async (t) => {
  const { window, element } = demoPage(t, '?host=native');
  const { createMockAdapter } = await import('../dist/packages/web-mock/src/index.js');
  const adapter = createMockAdapter({
    deviceInfo: { os: 'ios', osVersion: '27.2' },
    getNetworkStatus: () => ({ type: 'wifi' }),
    events: ['network.statusChanged'],
  });
  const unlisten = adapter.listen((raw) => window.__OJSB_RECEIVE__(raw));
  t.after(unlisten);
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
      response.rpc.result.host = { platform: 'ios', name: 'ios-wk', version: '0.2.0' };
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

  element('#device-info').dispatchEvent(new Event('click'));
  await setImmediate();
  assert.deepEqual(JSON.parse(element('#result').textContent), { os: 'ios', osVersion: '27.2' });
  element('#network-status').dispatchEvent(new Event('click'));
  await setImmediate();
  assert.deepEqual(JSON.parse(element('#result').textContent), { type: 'wifi' });
  assert.equal(element('#event-demo').hidden, false);
  assert.equal(element('#emit-event').hidden, true);

  element('#toggle-event').dispatchEvent(new Event('click'));
  await setImmediate();
  assert.equal(element('#event-status').textContent, '已订阅');
  assert.equal(adapter.emit('network.statusChanged', { type: 'cellular' }), true);
  assert.deepEqual(JSON.parse(element('#event-result').textContent), { type: 'cellular' });
  element('#toggle-event').dispatchEvent(new Event('click'));
  await setImmediate();
  assert.equal(adapter.emit('network.statusChanged', { type: 'none' }), false);
  assert.deepEqual(methods, [
    'bridge.hello', 'conformance.echo', 'device.getInfo', 'network.getStatus',
    'bridge.subscribe', 'bridge.unsubscribe',
  ]);
});

test('web-demo HTTP server serves the complete ES module graph without 404s and rejects disallowed paths', async (t) => {
  const child = spawn(process.execPath, ['examples/web-demo/serve.mjs', '0'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    child.kill('SIGTERM');
  });

  const baseUrl = await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`web-demo server timed out: ${stderr}`)), 5000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = /http:\/\/127\.0\.0\.1:\d+\//.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`web-demo server exited early (${code}): ${stderr}`));
    });
  });

  // Static page and CSS assets
  for (const [pathname, expectedType] of [
    ['/', 'text/html; charset=utf-8'],
    ['/styles.css', 'text/css; charset=utf-8'],
    ['/tokens.css', 'text/css; charset=utf-8'],
  ]) {
    const res = await fetch(new URL(pathname, baseUrl));
    assert.equal(res.status, 200, `${pathname} should return 200`);
    assert.equal(res.headers.get('content-type'), expectedType);
  }

  // Recursively walk every static and dynamic ES module import reachable from /demo.js and /dist/packages/web-sdk/src/reverse.js
  const visited = new Set();
  const queue = ['/demo.js', '/dist/packages/web-sdk/src/reverse.js', '/dist/packages/web-sdk/src/fallback.js'];
  const importPattern = /(?:(?:import|export)\s+(?:[^'"]*?\s+from\s+)?|import\s*\(\s*)['"](\.\.?\/[^'"]+\.js)['"]/g;

  while (queue.length > 0) {
    const pathname = queue.shift();
    if (visited.has(pathname)) continue;
    visited.add(pathname);

    const url = new URL(pathname, baseUrl);
    const res = await fetch(url);
    assert.equal(res.status, 200, `Expected 200 for imported module ${pathname}`);
    assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
    const source = await res.text();
    for (const match of source.matchAll(importPattern)) {
      const resolved = new URL(match[1], url).pathname;
      if (!visited.has(resolved)) queue.push(resolved);
    }
  }

  assert.equal(visited.has('/dist/packages/host-core/src/index.js'), true);
  assert.equal(visited.has('/dist/packages/web-sdk/src/reverse-slot.js'), true);
  assert.equal(visited.has('/dist/packages/devtools/src/index.js'), true);

  // Disallowed methods & paths
  const postRes = await fetch(new URL('/', baseUrl), { method: 'POST' });
  assert.equal(postRes.status, 405);
  const missingRes = await fetch(new URL('/package.json', baseUrl));
  assert.equal(missingRes.status, 404);
});
