import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const maxCoreBytes = 7 * 1024;
const entry = fileURLToPath(new URL('../dist/packages/web-sdk/src/index.js', import.meta.url));
const { outputFiles } = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  write: false,
});

const size = gzipSync(outputFiles[0].contents, { level: 9 }).byteLength;
console.log(`Web core (min+gzip): ${size} / ${maxCoreBytes} bytes`);
if (size > maxCoreBytes) process.exitCode = 1;
