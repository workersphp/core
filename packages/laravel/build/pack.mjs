#!/usr/bin/env node
// Pack a Laravel app into a secret-free zip for the Workers runtime.
//
// Usage: node pack.mjs <app-dir> <output-zip>
//
// - composer install --no-dev + classmap-authoritative autoloader
// - excludes .env (generated at boot from Worker secrets), git/node/test cruft,
//   local sqlite databases, logs, compiled views/sessions/cache
// - prunes Carbon's 800+ locale files down to en
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [appDir, outZip] = process.argv.slice(2, 4).map((p) => p && resolve(p));
const bake = process.argv.includes('--bake');

if (!appDir || !outZip) {
	console.error('usage: pack.mjs <app-dir> <output-zip> [--bake]');
	process.exit(1);
}
if (!existsSync(appDir + '/artisan')) {
	console.error(`${appDir} does not look like a Laravel app (no artisan)`);
	process.exit(1);
}

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: appDir, stdio: 'inherit', ...opts });

console.error('[pack] composer install --no-dev');
run('composer', ['install', '--no-dev', '--no-interaction', '--prefer-dist', '--no-progress']);
console.error('[pack] composer dump-autoload --classmap-authoritative --no-dev');
run('composer', ['dump-autoload', '--classmap-authoritative', '--no-dev']);

// Bake AFTER composer: Laravel's post-autoload-dump hook clears cached
// config/services, so artifact generation must be the last write.
if (bake) {
	execFileSync('node', [resolve(dirname(process.argv[1] ?? ''), 'bake.mjs'), appDir], { stdio: 'inherit' });
}

mkdirSync(dirname(outZip), { recursive: true });

console.error('[pack] zipping (secret-free)');
// Always a fresh archive: -FS sync mode compares mtimes, and the bake stamps
// every file to fixed epochs — changed files look unchanged and stale entries
// survive. Learned the hard way.
rmSync(outZip, { force: true });
run('zip', [
	'-qr', outZip, '.',
	'-x',
	'.env', '.env.*', '.git/*', 'node_modules/*', 'tests/*',
	'database/*.sqlite', 'database/*.sqlite-*',
	'storage/logs/*', 'storage/framework/cache/data/*',
	'storage/framework/sessions/*',
	'vendor/nesbot/carbon/src/Carbon/Lang/*',
	'*.md', 'vendor/*/.github/*', 'package-lock.json',
	'*.stub', 'vendor/*/*/CHANGELOG*', 'vendor/*/*/UPGRADE*', 'vendor/*/*/phpunit.xml*',
]);
// Keep English locale for Carbon.
run('zip', ['-q', outZip, 'vendor/nesbot/carbon/src/Carbon/Lang/en.php']);

const size = statSync(outZip).size;
console.error(`[pack] done: ${outZip} (${(size / 1048576).toFixed(1)} MB)`);
if (size > 25 * 1048576) {
	console.error('[pack] WARNING: zip exceeds the 25 MiB Static Assets per-file limit');
	process.exit(2);
}
