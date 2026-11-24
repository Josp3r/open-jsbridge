import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const output = fileURLToPath(new URL('dist/', root));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run npm run pack:web to build the Web package');

await mkdir(output, { recursive: true });
// Keep package assembly separate from the demo build and any previous output.
const staging = await mkdtemp(join(output, '.web-package-'));
try {
  execFileSync(process.execPath, [npm, 'run', 'build', '--', '--outDir', staging], {
    cwd: root,
    stdio: 'inherit',
  });

  await Promise.all([
    copyFile(new URL('scripts/web-package.json', root), join(staging, 'package.json')),
    copyFile(new URL('scripts/web-package.README.md', root), join(staging, 'README.md')),
  ]);

  const report = execFileSync(process.execPath, [
    npm, 'pack', '--offline', '--ignore-scripts', '--json',
    '--cache', join(staging, '.npm-cache'), '--pack-destination', staging, staging,
  ], { cwd: root, encoding: 'utf8' });
  const [{ filename }] = JSON.parse(report);
  const archive = join(output, filename);
  await rename(join(staging, filename), archive);
  console.log(archive);
} finally {
  await rm(staging, { recursive: true, force: true });
}
