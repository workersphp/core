#!/usr/bin/env node
// Ensure the PHP wasm binary exists in packages/php-wasm-jspi/.
//
// In the private monorepo (and on a maintainer machine after a build) the
// files are already on disk. In a fresh public checkout they are not in git:
// this script downloads the published @workersphp/php-wasm-jspi tarball and
// unpacks the binaries into the workspace package. `npm pack` is used
// because the workspace package shadows the registry one, so a plain
// dependency can never deliver the files here.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = join(repo, 'packages/php-wasm-jspi');

if (existsSync(join(packageDir, 'php8.5-web.mjs.wasm'))) {
  console.log('[binaries] php-wasm-jspi binary present');
  process.exit(0);
}

const stage = mkdtempSync(join(tmpdir(), 'php-wasm-jspi-'));
try {
  console.log('[binaries] fetching @workersphp/php-wasm-jspi from the registry');
  execFileSync('npm', ['pack', '@workersphp/php-wasm-jspi@latest', '--pack-destination', stage], { stdio: 'inherit' });
  const tarball = execFileSync('ls', [stage], { encoding: 'utf8' }).trim().split('\n')[0];
  execFileSync('tar', ['-xzf', join(stage, tarball), '-C', stage]);
  for (const file of ['php8.5-web.mjs', 'php8.5-web.mjs.wasm']) {
    cpSync(join(stage, 'package', file), join(packageDir, file));
  }
  console.log('[binaries] unpacked into packages/php-wasm-jspi/');
} finally {
  rmSync(stage, { recursive: true, force: true });
}
