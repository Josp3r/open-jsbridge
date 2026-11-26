import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachDevtools,
  createDevtools,
  defaultRedactEnvelope,
  mountDevtoolsOverlay,
} from '../dist/packages/devtools/src/index.js';
import { ErrorCode } from '../dist/packages/protocol/src/index.js';
import { createMockAdapter, HostError } from '../dist/packages/web-mock/src/index.js';
import { createBridge } from '../dist/packages/web-sdk/src/index.js';
import { createReverseHandlers } from '../dist/packages/web-sdk/src/reverse.js';

function createFakeDom() {
  class FakeNode {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.parentNode = null;
      this.attributes = new Map();
      this.listeners = new Map();
      this.style = {};
      this.className = '';
      this.textContent = '';
      this.value = '';
      this.type = '';
      this.placeholder = '';
      this.shadowRoot = null;
    }

    get firstChild() {
      return this.children[0] ?? null;
    }

    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    }

    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx >= 0) {
        this.children.splice(idx, 1);
        child.parentNode = null;
      }
      return child;
    }

    remove() {
      this.parentNode?.removeChild(this);
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }

    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    }

    addEventListener(type, fn) {
      const list = this.listeners.get(type) ?? [];
      list.push(fn);
      this.listeners.set(type, list);
    }

    dispatch(type) {
      for (const fn of this.listeners.get(type) ?? []) {
        fn({ target: this });
      }
    }

    attachShadow({ mode }) {
      const shadow = new FakeNode('#shadow-root');
      shadow.mode = mode;
      this.shadowRoot = shadow;
      return shadow;
    }

    collectText() {
      const chunks = [];
      if (this.textContent) chunks.push(this.textContent);
      for (const child of this.children) chunks.push(child.collectText());
      if (this.shadowRoot) chunks.push(this.shadowRoot.collectText());
      return chunks.join('\n');
    }

    findAll(predicate, acc = []) {
      if (predicate(this)) acc.push(this);
      for (const child of this.children) child.findAll(predicate, acc);
      if (this.shadowRoot) this.shadowRoot.findAll(predicate, acc);
      return acc;
    }
  }

  const body = new FakeNode('body');
  const doc = {
    body,
    documentElement: body,
    createElement: (tag) => new FakeNode(tag),
  };
  return { document: doc, body };
}

test('createDevtools captures handshake capabilities, traffic, timings, errors, events, progress, and reverse calls', async () => {
  const baseAdapter = createMockAdapter({
    hostName: 'acme-ios',
    platform: 'ios',
    hostVersion: '1.4.0',
    events: ['network.statusChanged'],
    supportsCancel: true,
    supportsCallbacks: true,
    supportsReverse: true,
    handlers: {
      'acme.work': async (_params, ctx) => {
        ctx.callback({ pct: 50 });
        return { done: true };
      },
      'acme.boom': () => {
        throw new HostError(ErrorCode.PermissionDenied, 'No permission');
      },
    },
  });

  // Wrap adapter to inject meta.timing on responses so hostHandlerMs correlation is verified.
  const timedAdapter = {
    name: baseAdapter.name,
    listen: (cb) => baseAdapter.listen(cb),
    async send(raw) {
      const reply = await baseAdapter.send(raw);
      if (!reply) return null;
      const parsed = JSON.parse(reply);
      if (parsed.meta && !('method' in parsed.rpc)) {
        parsed.meta.timing = { recv: 100, start: 102, end: 117 };
      }
      return JSON.stringify(parsed);
    },
  };

  let clock = 1_700_000_000_000;
  const bridge = createBridge({ adapter: timedAdapter });
  const reverse = createReverseHandlers(bridge);
  reverse.handle('page.title', () => ({ title: 'Inspector' }));

  const devtools = createDevtools(bridge, { now: () => (clock += 10) });
  let notifications = 0;
  const unsub = devtools.subscribe(() => { notifications += 1; });

  await bridge.ready();

  // Check session & capability snapshot from bridge.hello
  const snap = devtools.session();
  assert.equal(snap.state, 'ready');
  assert.ok(snap.sid);
  assert.deepEqual(snap.host, { platform: 'ios', name: 'acme-ios', version: '1.4.0' });
  assert.deepEqual(snap.capabilities?.events, ['network.statusChanged']);
  assert.deepEqual(snap.capabilities?.features, ['cancel', 'callbacks', 'reverse']);
  assert.deepEqual(snap.capabilities?.methods['acme.work'], [1]);
  assert.ok(snap.limits?.maxMessageBytes);

  // Streaming call
  const progressChunks = [];
  const workResult = await bridge.call('acme.work', { task: 'a' }, {
    traceId: 'trace-123',
    onCallback: (chunk) => progressChunks.push(chunk),
  });
  assert.deepEqual(workResult, { done: true });
  assert.deepEqual(progressChunks, [{ pct: 50 }]);

  // RPC error call
  await assert.rejects(bridge.call('acme.boom'), { code: ErrorCode.PermissionDenied });

  // Event subscription + delivery
  const seenEvents = [];
  const off = bridge.on('network.statusChanged', (payload) => seenEvents.push(payload));
  await off.ready;
  baseAdapter.emit('network.statusChanged', { type: 'wifi' });
  assert.deepEqual(seenEvents, [{ type: 'wifi' }]);
  off();

  // Reverse call
  assert.deepEqual(await baseAdapter.callWeb('page.title'), { title: 'Inspector' });

  const entries = devtools.entries();
  const workResp = entries.find((e) => e.direction === 'receive' && e.kind === 'response' && e.method === 'acme.work');
  assert.ok(workResp);
  assert.equal(workResp.hostHandlerMs, 15);
  assert.equal(typeof workResp.roundTripMs, 'number');
  assert.equal(workResp.traceId, 'trace-123');
  assert.ok(workResp.bytes > 0);

  const boomErr = entries.find((e) => e.direction === 'receive' && e.kind === 'error' && e.method === 'acme.boom');
  assert.ok(boomErr);
  assert.equal(boomErr.code, ErrorCode.PermissionDenied);

  const progressEntry = entries.find((e) => e.direction === 'receive' && e.kind === 'notification' && e.method === 'bridge.progress');
  assert.ok(progressEntry);

  const eventEntry = entries.find((e) => e.direction === 'receive' && e.kind === 'notification' && e.method === 'bridge.event');
  assert.ok(eventEntry);

  const reverseReq = entries.find((e) => e.direction === 'receive' && e.kind === 'request' && e.method === 'page.title');
  assert.ok(reverseReq);

  assert.ok(notifications > 0);
  assert.equal(devtools.session().totalErrors, 1);

  // HAR export structure
  const har = devtools.exportHar();
  assert.equal(har.log.version, '1.2');
  assert.equal(har.log.creator.name, '@open-jsbridge/devtools');
  assert.equal(har.log.entries.length, entries.length);
  const workHar = har.log.entries.find((item) => item._ojsb.method === 'acme.work' && item._ojsb.direction === 'receive');
  assert.ok(workHar);
  assert.equal(workHar.request.url, 'ojsb://acme-ios/acme.work');
  assert.equal(workHar.response.status, 200);
  assert.equal(workHar.timings.wait, 15);
  assert.ok(workHar.request.headers.some((h) => h.name === 'x-ojsb-trace-id' && h.value === 'trace-123'));

  const parsedHarJson = JSON.parse(devtools.exportHarJson(false));
  assert.equal(parsedHarJson.log.entries.length, entries.length);

  // Clear & detach
  devtools.clear();
  assert.equal(devtools.entries().length, 0);
  assert.equal(devtools.session().totalMessages, 0);
  assert.equal(devtools.session().totalErrors, 0);

  unsub();
  devtools.detach();
  await bridge.call('conformance.echo', { afterDetach: true });
  assert.equal(devtools.entries().length, 0);

  bridge.close();
});

test('default redaction protects credentials and large thumbnails without mutating wire payloads', async () => {
  const seenOnHost = [];
  const bigThumb = 'A'.repeat(256);
  const adapter = createMockAdapter({
    handlers: {
      'acme.secure': (params) => {
        seenOnHost.push(params);
        return {
          thumbnailBase64: bigThumb,
          access_token: 'secret-access-token',
          safe: 'visible',
        };
      },
    },
  });

  const bridge = createBridge({ adapter });
  const devtools = createDevtools(bridge);

  const result = await bridge.call('acme.secure', {
    authorization: 'Bearer live-token',
    cookie: 'sid=top-secret',
    note: 'plain',
  });

  // Wire traffic is completely untouched.
  assert.deepEqual(seenOnHost, [{
    authorization: 'Bearer live-token',
    cookie: 'sid=top-secret',
    note: 'plain',
  }]);
  assert.deepEqual(result, {
    thumbnailBase64: bigThumb,
    access_token: 'secret-access-token',
    safe: 'visible',
  });

  // Recorded snapshots and exported HAR are redacted.
  const harText = devtools.exportHarJson(false);
  assert.equal(harText.includes('Bearer live-token'), false);
  assert.equal(harText.includes('sid=top-secret'), false);
  assert.equal(harText.includes('secret-access-token'), false);
  assert.equal(harText.includes(bigThumb), false);
  assert.equal(harText.includes('[redacted:256 chars]'), true);
  assert.equal(harText.includes('plain'), true);
  assert.equal(harText.includes('visible'), true);

  // Standalone defaultRedactEnvelope check
  const sample = defaultRedactEnvelope({
    jsb: '1.0',
    rpc: { jsonrpc: '2.0', id: '1', method: 'acme.login', params: { password: 'p', ok: 1 } },
  });
  assert.deepEqual(sample.rpc.params, { password: '[redacted]', ok: 1 });

  devtools.detach();
  bridge.close();
});

test('ring buffer enforces maxEntries limit cleanly', async () => {
  const adapter = createMockAdapter();
  const bridge = createBridge({ adapter });
  const devtools = createDevtools(bridge, { maxEntries: 3 });

  for (let i = 0; i < 5; i += 1) {
    await bridge.call('conformance.echo', { i });
  }

  const entries = devtools.entries();
  assert.equal(entries.length, 3);
  assert.ok(entries[0].seq < entries[1].seq && entries[1].seq < entries[2].seq);

  devtools.detach();
  bridge.close();
});

test('mountDevtoolsOverlay renders Shadow DOM inspector, filters, exports HAR, and unmounts cleanly', async (t) => {
  const prevDoc = globalThis.document;
  t.after(() => { globalThis.document = prevDoc; });

  // Throws descriptive error when DOM is absent.
  globalThis.document = undefined;
  const headless = createDevtools();
  assert.throws(() => mountDevtoolsOverlay(headless), /requires a browser DOM/);

  // Mount in fake DOM and test interactive controls.
  const fake = createFakeDom();
  globalThis.document = fake.document;

  const adapter = createMockAdapter({
    hostName: 'mock-browser',
    events: ['app.foregrounded'],
    handlers: {
      'acme.fail': () => { throw new HostError(ErrorCode.Busy, 'Busy now'); },
    },
  });
  const bridge = createBridge({ adapter });
  const exported = [];
  const attached = attachDevtools(bridge, {
    mount: {
      position: 'top-left',
      initiallyOpen: false,
      onExportHar: (json) => exported.push(json),
    },
  });

  assert.ok(attached.overlay);
  assert.equal(attached.overlay.isOpen(), false);
  assert.equal(fake.body.children.length, 1);
  assert.equal(attached.overlay.hostElement.getAttribute('data-ojsb-devtools'), 'true');
  assert.ok(attached.overlay.hostElement.shadowRoot);

  await bridge.call('conformance.echo', { hello: 'overlay' });
  await assert.rejects(bridge.call('acme.fail'), { code: ErrorCode.Busy });

  // Open panel and inspect rendered text.
  attached.overlay.toggle();
  assert.equal(attached.overlay.isOpen(), true);
  const shadow = attached.overlay.hostElement.shadowRoot;
  let rendered = shadow.collectText();
  assert.equal(rendered.includes('conformance.echo'), true);
  assert.equal(rendered.includes('acme.fail'), true);
  assert.equal(rendered.includes(`ERR ${ErrorCode.Busy}`), true);

  // Click Errors filter button -> hides non-error entries.
  const buttons = shadow.findAll((node) => node.tagName === 'button');
  const errorsBtn = buttons.find((b) => b.textContent === 'Errors');
  const capsBtn = buttons.find((b) => b.textContent === 'Capabilities');
  const exportBtn = buttons.find((b) => b.textContent === 'Export HAR');
  const clearBtn = buttons.find((b) => b.textContent === 'Clear');
  assert.ok(errorsBtn && capsBtn && exportBtn && clearBtn);

  errorsBtn.dispatch('click');
  rendered = shadow.collectText();
  assert.equal(rendered.includes('acme.fail'), true);
  assert.equal(rendered.includes('conformance.echo'), false);

  // Switch to Capabilities tab -> shows methods & events.
  capsBtn.dispatch('click');
  rendered = shadow.collectText();
  assert.equal(rendered.includes('acme.fail (@1)'), true);
  assert.equal(rendered.includes('app.foregrounded'), true);

  // Export HAR button invokes callback with valid HAR JSON.
  exportBtn.dispatch('click');
  assert.equal(exported.length, 1);
  assert.equal(JSON.parse(exported[0]).log.version, '1.2');

  // Clear button empties entries.
  clearBtn.dispatch('click');
  assert.equal(attached.controller.entries().length, 0);

  // Destroy unmounts host element and detaches plugin.
  attached.destroy();
  assert.equal(fake.body.children.length, 0);

  bridge.close();
});
