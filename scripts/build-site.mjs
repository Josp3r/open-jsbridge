import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const siteDir = join(root, 'site');
const outDir = join(root, 'dist', 'site');

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [join(siteDir, 'playground.ts')],
  outfile: join(outDir, 'playground.js'),
  bundle: true,
  format: 'esm',
  target: 'es2020',
  minify: true,
  sourcemap: true,
});

await Promise.all([
  copyFile(join(siteDir, 'index.html'), join(outDir, 'index.html')),
  copyFile(join(siteDir, 'styles.css'), join(outDir, 'styles.css')),
  writeFile(join(outDir, '.nojekyll'), ''),
]);

console.log(`Built static community site and Playground in ${outDir}`);
