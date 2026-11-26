import assert from 'node:assert/strict';
import test from 'node:test';
import { createAclPolicy, createHostCore } from '../dist/packages/host-core/src/index.js';
import { ErrorCode } from '../dist/packages/protocol/src/index.js';

function helloRaw(id = 'h-1') {
  return JSON.stringify({
    jsb: '1.0',
    rpc: { jsonrpc: '2.0', id, method: 'bridge.hello', params: { protocols: [1] } },
  });
}

function reqRaw(sid, id, method, params) {
  return JSON.stringify({
    jsb: '1.0',
    meta: { sid },
    rpc: { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) },
  });
}

const sampleConfig = {
  version: 1,
  rules: [
    {
      origins: ['https://m.acme.com', 'https://*.acme.com'],
      frames: 'main',
      allow: ['device.*', 'ui.*', 'acme.pay.*'],
      deny: ['acme.pay.refund'],
    },
    {
      origins: ['https://partner.example.org'],
      frames: 'any',
      allow: ['ui.toast.show', 'app.getInfo'],
      rateLimit: { perSecond: 2 },
    },
  ],
  default: 'deny',
};

test('createAclPolicy validates schema, enforces default: deny, and rejects unsafe origin/method patterns', () => {
  assert.throws(() => createAclPolicy({ ...sampleConfig, version: 2 }), /Unsupported ACL config version/);
  assert.throws(() => createAclPolicy({ ...sampleConfig, default: 'allow' }), /default MUST be "deny"/);
  assert.throws(
    () => createAclPolicy({ version: 1, rules: [{ origins: ['http://m.acme.com'], allow: ['*'] }], default: 'deny' }),
    /Invalid ACL origin pattern/,
  );
  assert.throws(
    () => createAclPolicy({ version: 1, rules: [{ origins: ['https://*'], allow: ['*'] }], default: 'deny' }),
    /Invalid ACL origin pattern/,
  );
  assert.throws(
    () => createAclPolicy({ version: 1, rules: [{ origins: ['https://*.com'], allow: ['*'] }], default: 'deny' }),
    /Invalid ACL origin pattern/,
  );
  assert.throws(
    () => createAclPolicy({ version: 1, rules: [{ origins: ['https://m.acme.com/path'], allow: ['*'] }], default: 'deny' }),
    /Invalid ACL origin pattern/,
  );
  assert.throws(
    () => createAclPolicy({ version: 1, rules: [{ origins: ['https://m.acme.com'], allow: ['rpc.list'] }], default: 'deny' }),
    /Invalid ACL method pattern/,
  );
  assert.throws(
    () => createAclPolicy({
      version: 1,
      rules: [{ origins: ['https://m.acme.com'], allow: ['device.*'], rateLimit: { perSecond: 0 } }],
      default: 'deny',
    }),
    /perSecond/,
  );
});

test('ACL enforces exact & strict subdomain HTTPS origins and deny-over-allow precedence', () => {
  const acl = createAclPolicy(sampleConfig);

  // Exact origin allowed for device.* and acme.pay.create, denied for acme.pay.refund and unlisted methods.
  assert.equal(acl.evaluate({ origin: 'https://m.acme.com', isMainFrame: true }, 'device.getInfo').allowed, true);
  assert.equal(acl.evaluate({ origin: 'https://m.acme.com', isMainFrame: true }, 'acme.pay.create').allowed, true);

  const deniedRefund = acl.evaluate({ origin: 'https://m.acme.com', isMainFrame: true }, 'acme.pay.refund');
  assert.equal(deniedRefund.allowed, false);
  assert.equal(deniedRefund.code, ErrorCode.PermissionDenied);
  assert.equal(deniedRefund.reason, 'acl_denied');

  const deniedDefault = acl.evaluate({ origin: 'https://m.acme.com', isMainFrame: true }, 'storage.get');
  assert.equal(deniedDefault.allowed, false);
  assert.equal(deniedDefault.reason, 'acl_denied');

  // Prefix matching must NOT match `devices.getInfo` for `device.*`.
  assert.equal(acl.evaluate({ origin: 'https://m.acme.com', isMainFrame: true }, 'devices.getInfo').allowed, false);

  // Strict subdomain wildcard matching.
  assert.equal(acl.evaluate({ origin: 'https://shop.acme.com', isMainFrame: true }, 'device.getInfo').allowed, true);
  assert.equal(acl.evaluate({ origin: 'https://a.b.acme.com', isMainFrame: true }, 'device.getInfo').allowed, true);
  assert.equal(acl.evaluate({ origin: 'https://acme.com', isMainFrame: true }, 'device.getInfo').allowed, false);
  assert.equal(acl.evaluate({ origin: 'https://evilacme.com', isMainFrame: true }, 'device.getInfo').allowed, false);
  assert.equal(acl.evaluate({ origin: 'https://m.acme.com.evil.test', isMainFrame: true }, 'device.getInfo').allowed, false);
  assert.equal(acl.evaluate({ origin: 'https://shop.acme.com:8443', isMainFrame: true }, 'device.getInfo').allowed, false);
  assert.equal(acl.evaluate({ origin: 'http://shop.acme.com', isMainFrame: true }, 'device.getInfo').allowed, false);
});

test('Protocol F5: frames: "any" cannot enable iframe calls unless host sets supportsIframe: true', async () => {
  // Without supportsIframe: true, partner subframe is blocked despite frames: "any".
  const defaultHost = createHostCore({ acl: sampleConfig });
  defaultHost.register('ui.toast.show', () => ({}));
  const deniedHello = JSON.parse(
    await defaultHost.receive(helloRaw('h-sub-1'), { origin: 'https://partner.example.org', isMainFrame: false }),
  );
  assert.equal(deniedHello.rpc.error.code, ErrorCode.PermissionDenied);
  assert.equal(deniedHello.rpc.error.data.reason, 'frame_not_allowed');

  // With supportsIframe: true, partner subframe succeeds and advertises "iframe", while main-only acme subframe stays blocked.
  const iframeHost = createHostCore({ acl: sampleConfig, supportsIframe: true });
  iframeHost.register('ui.toast.show', () => ({}));
  iframeHost.register('device.getInfo', () => ({ os: 'ios', osVersion: '26' }));

  const blockedMainOnly = JSON.parse(
    await iframeHost.receive(helloRaw('h-sub-acme'), { origin: 'https://m.acme.com', isMainFrame: false }),
  );
  assert.equal(blockedMainOnly.rpc.error.code, ErrorCode.PermissionDenied);
  assert.equal(blockedMainOnly.rpc.error.data.reason, 'frame_not_allowed');

  const okPartner = JSON.parse(
    await iframeHost.receive(helloRaw('h-sub-partner'), { origin: 'https://partner.example.org', isMainFrame: false }),
  );
  assert.ok(okPartner.rpc.result.capabilities.features.includes('iframe'));
  assert.deepEqual(Object.keys(okPartner.rpc.result.capabilities.methods), ['ui.toast.show']);
});

test('HostCore filters hello capabilities by ACL and enforces per-second rateLimit (-32008)', async () => {
  let clock = 10_000;
  let toastCalls = 0;
  const host = createHostCore({
    acl: sampleConfig,
    caller: { origin: 'https://partner.example.org', isMainFrame: true },
    now: () => clock,
  });
  host.register('ui.toast.show', () => { toastCalls += 1; return {}; });
  host.register('acme.pay.create', () => ({ paid: true }));

  // Handshake filters capabilities to only allowed methods and does not consume rate limit.
  const hello = JSON.parse(await host.receive(helloRaw('h-1')));
  const sid = hello.rpc.result.sid;
  assert.deepEqual(Object.keys(hello.rpc.result.capabilities.methods), ['ui.toast.show']);

  // Calling an unpermitted method returns -32003 without executing handler.
  const denied = JSON.parse(await host.receive(reqRaw(sid, 'r-denied', 'acme.pay.create')));
  assert.equal(denied.rpc.error.code, ErrorCode.PermissionDenied);
  assert.equal(denied.rpc.error.data.reason, 'acl_denied');

  // 2 calls within 1 second succeed; 3rd call hits -32008.
  const r1 = JSON.parse(await host.receive(reqRaw(sid, 'r-1', 'ui.toast.show', { text: 'a' })));
  const r2 = JSON.parse(await host.receive(reqRaw(sid, 'r-2', 'ui.toast.show', { text: 'b' })));
  const r3 = JSON.parse(await host.receive(reqRaw(sid, 'r-3', 'ui.toast.show', { text: 'c' })));
  assert.deepEqual(r1.rpc.result, {});
  assert.deepEqual(r2.rpc.result, {});
  assert.equal(r3.rpc.error.code, ErrorCode.RateLimited);
  assert.equal(r3.rpc.error.data.reason, 'rate_limited');
  assert.equal(toastCalls, 2);

  // Advancing clock past 1 second window restores quota.
  clock += 1001;
  const r4 = JSON.parse(await host.receive(reqRaw(sid, 'r-4', 'ui.toast.show', { text: 'd' })));
  assert.deepEqual(r4.rpc.result, {});
  assert.equal(toastCalls, 3);
});

test('SEC-ACL-ERROR-001: throwing authorization rule aborts dispatch, returns -32603, and leaks no internal details', async () => {
  let shouldThrow = false;
  let handlerCalls = 0;

  const host = createHostCore({
    acl: sampleConfig,
    caller: { origin: 'https://m.acme.com', isMainFrame: true },
    events: ['network.statusChanged'],
    authorize() {
      if (shouldThrow) {
        throw new Error('secret-policy-db-token-12345');
      }
      return true;
    },
  });
  host.register('device.getInfo', () => {
    handlerCalls += 1;
    return { os: 'android', osVersion: '15' };
  });

  // Handshake succeeds in an authorized context.
  const hello = JSON.parse(await host.receive(helloRaw('h-ok')));
  const sid = hello.rpc.result.sid;

  // Trigger unclassified exception in policy chain during business method call.
  shouldThrow = true;
  const rawReply = await host.receive(reqRaw(sid, 'r-boom', 'device.getInfo'));
  assert.ok(rawReply);
  assert.equal(handlerCalls, 0, 'handler MUST NOT be invoked when ACL throws');
  assert.equal(rawReply.includes('secret-policy-db-token'), false, 'response MUST NOT leak internal exception details');

  const reply = JSON.parse(rawReply);
  assert.equal(reply.meta.sid, sid);
  assert.equal(reply.rpc.id, 'r-boom');
  assert.equal(reply.rpc.error.code, ErrorCode.InternalError);
  assert.equal(reply.rpc.error.message, 'Internal error');
  assert.equal(reply.rpc.error.data, undefined);

  // Trigger unclassified exception during bridge.subscribe as well.
  const subReply = JSON.parse(
    await host.receive(reqRaw(sid, 'sub-boom', 'bridge.subscribe', { events: ['network.statusChanged'] })),
  );
  assert.equal(subReply.rpc.error.code, ErrorCode.InternalError);
  assert.equal(JSON.stringify(subReply).includes('secret-policy-db-token'), false);
});
