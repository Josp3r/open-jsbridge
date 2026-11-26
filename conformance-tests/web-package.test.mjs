import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('the packed ESM SDK separates the factory and the shared page singleton', async (t) => {
  const npm = process.env.npm_execpath;
  assert.ok(npm, 'Run this package test through npm');
  const consumer = await mkdtemp(join(tmpdir(), 'ojsb-web-package-'));
  t.after(() => rm(consumer, { recursive: true, force: true }));
  const packOutput = execFileSync(process.execPath, [npm, 'run', '--silent', 'pack:web'], {
    cwd: root,
    encoding: 'utf8',
  });
  const tarball = packOutput.trim().split('\n').at(-1);
  await writeFile(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
  execFileSync(process.execPath, [
    npm, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock',
    '--cache', join(consumer, '.npm-cache'), '--userconfig', join(consumer, '.npmrc'),
    '--globalconfig', join(consumer, '.npmrc-global'), tarball,
  ], { cwd: consumer, stdio: 'pipe' });

  const packageDir = join(consumer, 'node_modules', '@open-jsbridge', 'web');
  const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.exports).sort(), [
    '.', './app', './auto', './device', './media', './mock', './network', './ui',
  ]);
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.sideEffects, false);
  assert.equal(manifest.license, 'MIT');
  assert.equal(await readFile(join(packageDir, 'LICENSE'), 'utf8'), await readFile(join(root, 'LICENSE'), 'utf8'));

  execFileSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import * as core from '@open-jsbridge/web';

    assert.deepEqual(Object.keys(core).sort(), ['BridgeError', 'ErrorCode', 'createBridge']);
    assert.throws(() => createRequire(import.meta.url)('@open-jsbridge/web'), {
      code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    });
    const { createMockAdapter, installMockTransport } = await import('@open-jsbridge/web/mock');
    const isolated = core.createBridge({ adapter: createMockAdapter() });
    assert.deepEqual(await isolated.call('conformance.echo', { text: 'core' }), { text: 'core' });

    const auto = await import('@open-jsbridge/web/auto');
    for (const name of ['app', 'device', 'media', 'network', 'ui']) {
      assert.equal(auto[name], (await import('@open-jsbridge/web/' + name))[name]);
    }
    assert.equal(auto.bridge.state, 'idle');
    globalThis.window = new EventTarget();
    const shown = [];
    const requests = [];
    installMockTransport({
      deviceInfo: { os: 'ios', osVersion: '26.2' },
      getNetworkStatus: () => ({ type: 'wifi' }),
      showToast: (text) => { shown.push(text); },
      onFrame: (direction, raw) => {
        if (direction === 'request') requests.push(JSON.parse(raw).rpc);
      },
    });
    assert.deepEqual(await auto.device.getInfo(), { os: 'ios', osVersion: '26.2' });
    assert.deepEqual(await auto.network.getStatus(), { type: 'wifi' });
    assert.deepEqual(await auto.ui.toast.show({ text: 'auto' }), {});
    assert.equal(auto.bridge.state, 'ready');
    assert.deepEqual(shown, ['auto']);
    assert.deepEqual(requests.map(request => request.method),
      ['bridge.hello', 'device.getInfo@1', 'network.getStatus@1', 'ui.toast.show@1']);
    assert.equal(requests[0].params.sdk.version, ${JSON.stringify(manifest.version)});
    await assert.rejects(auto.media.chooseMedia(), { code: core.ErrorCode.MethodNotFound });
  `], { cwd: consumer, stdio: 'pipe' });

  await writeFile(join(consumer, 'consumer.ts'), `
    import { createBridge, type Bridge, type ChooseMediaResult } from '@open-jsbridge/web';
    import * as auto from '@open-jsbridge/web/auto';
    import { app } from '@open-jsbridge/web/app';
    import { device } from '@open-jsbridge/web/device';
    import { media } from '@open-jsbridge/web/media';
    import { createMockAdapter } from '@open-jsbridge/web/mock';
    import { network } from '@open-jsbridge/web/network';
    import { ui } from '@open-jsbridge/web/ui';

    const isolated: Bridge = createBridge({ adapter: createMockAdapter() });
    const automatic: Bridge = auto.bridge;
    const off = app.onForegrounded((value: null) => value);
    const info = device.getInfo();
    const status = network.getStatus();
    const shown: Promise<Record<string, never>> = ui.toast.show({ text: 'auto' });
    const selection: Promise<ChooseMediaResult> = media.chooseMedia();
    export { isolated, automatic, off, info, status, shown, selection };
  `);
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const flags = ['--noEmit', '--strict', '--target', 'ES2020', 'consumer.ts'];
  execFileSync(process.execPath, [tsc, ...flags, '--module', 'NodeNext'], { cwd: consumer, stdio: 'pipe' });
  execFileSync(process.execPath, [
    tsc, ...flags, '--module', 'ESNext', '--moduleResolution', 'Bundler',
  ], { cwd: consumer, stdio: 'pipe' });
});
