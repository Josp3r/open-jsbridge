import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const outDir = join(root, 'dist', 'site');

test('community homepage and Playground build into self-contained static assets', async () => {
  execFileSync(process.execPath, [join(root, 'scripts', 'build-site.mjs')], {
    cwd: root,
    stdio: 'pipe',
  });

  const [html, css, js, nojekyll] = await Promise.all([
    readFile(join(outDir, 'index.html'), 'utf8'),
    readFile(join(outDir, 'styles.css'), 'utf8'),
    readFile(join(outDir, 'playground.js'), 'utf8'),
    stat(join(outDir, '.nojekyll')),
  ]);

  assert.ok(nojekyll.isFile(), 'Expected .nojekyll marker for GitHub Pages');
  assert.ok(css.length > 1000, 'Expected non-empty stylesheet');
  assert.ok(js.length > 5000, 'Expected bundled Playground runtime');

  // Verify bundled JS parses cleanly under Node.
  execFileSync(process.execPath, ['--check', join(outDir, 'playground.js')], {
    cwd: root,
    stdio: 'pipe',
  });

  // Verify SEO & zero third-party script dependencies.
  assert.match(html, /<title>[^<]*Open JSBridge[^<]*<\/title>/);
  assert.match(html, /<meta name="description" content="[^"]+">/);
  const h1Matches = html.match(/<h1\b[^>]*>/g) ?? [];
  assert.equal(h1Matches.length, 1, 'Expected exactly one <h1> on the homepage');
  assert.doesNotMatch(html, /<script[^>]+src="https?:\/\//i, 'Homepage must not load third-party CDN scripts');

  // Verify real protocol & capability endpoints are wired into the Playground bundle.
  assert.match(js, /device\.getInfo@1/);
  assert.match(js, /media\.chooseMedia@1/);
  assert.match(js, /media\.release@1/);
  assert.match(js, /transfer\.upload@1/);
  assert.match(js, /network\.statusChanged/);
});
