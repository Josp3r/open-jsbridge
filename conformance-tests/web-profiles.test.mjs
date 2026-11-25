import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const manifest = JSON.parse(readFileSync(new URL('../scripts/web-package.json', import.meta.url), 'utf8'));

test('the Web profile entries export types and bundle without unrelated profiles', async () => {
  assert.equal(manifest.sideEffects, false);
  for (const name of ['app', 'device', 'network', 'ui', 'media']) {
    const entry = manifest.exports[`./${name}`];
    assert.ok(entry.types.endsWith('.d.ts'));
    const { outputFiles } = await build({
      entryPoints: [fileURLToPath(new URL(`../dist/${entry.import.slice(2)}`, import.meta.url))],
      bundle: true,
      write: false,
      format: 'esm',
    });
    const output = outputFiles[0].text;
    for (const [profile, method] of [
      ['app', 'app.backgrounded'],
      ['device', 'device.getInfo@1'],
      ['network', 'network.getStatus@1'],
      ['ui', 'ui.toast.show@1'],
      ['media', 'media.chooseMedia@1'],
    ]) {
      assert.equal(output.includes(method), profile === name, `${name} bundle: ${method}`);
    }
  }
});
