import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = new URL('../', import.meta.url);
const output = fileURLToPath(new URL('dist/sdk-consumer/', root));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run npm run build:sdk-consumer to build the Release WebView page');

const packOutput = execFileSync(process.execPath, [npm, 'run', '--silent', 'pack:web'], {
  cwd: root,
  encoding: 'utf8',
});
const tarball = packOutput.trim().split('\n').at(-1);

await mkdir(output, { recursive: true });
const consumer = await mkdtemp(join(output, '.consumer-'));
try {
  await writeFile(join(consumer, 'package.json'), '{"private":true}\n');
  // Resolve the same package and entry point that a fresh H5 project installs.
  execFileSync(process.execPath, [
    npm, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
    '--no-package-lock', '--cache', join(consumer, '.npm-cache'), tarball,
  ], { cwd: consumer, stdio: 'inherit' });

  const [template, code] = await Promise.all([
    readFile(new URL('examples/sdk-consumer/ReleaseToast.html', root), 'utf8'),
    readFile(new URL('examples/sdk-consumer/ReleaseToast.mjs', root), 'utf8'),
  ]);
  const { outputFiles: [bundle] } = await build({
    absWorkingDir: consumer,
    stdin: { contents: code, resolveDir: consumer, sourcefile: 'ReleaseToast.mjs' },
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2020',
  });
  const html = template.replace('<!-- sdk-consumer-script -->', () => `<script>\n${bundle.text}</script>`);
  const page = join(consumer, 'ReleaseToast.html');
  await writeFile(page, html);
  await rename(page, join(output, 'ReleaseToast.html'));
  await copyFile(new URL('examples/sdk-consumer/MediaFixture.png', root), join(output, 'MediaFixture.png'));
  console.log(join(output, 'ReleaseToast.html'));
} finally {
  await rm(consumer, { recursive: true, force: true });
}
