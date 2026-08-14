#!/usr/bin/env node
// Bake compiled artifacts into a Laravel app before packing.
//
//   node bake.mjs <app-dir>
//
// Runs packages/build/bake.php inside php:8.5-cli with the app mounted at /app
// (the runtime's absolute path — Livewire class artifacts and OPcache keys embed
// it), then applies the three-tier fixed-epoch mtime scheme that keeps every
// timestamp comparison (Blade's >=, Volt's >=, Livewire's >) pointing the right
// way after zip round-trips (±2s DOS quantization, local-TZ mktime).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = process.argv[2] && resolve(process.argv[2]);

if (!appDir || !existsSync(appDir + '/artisan')) {
	console.error('usage: bake.mjs <laravel-app-dir>');
	process.exit(1);
}

console.error('[bake] compiling artifacts in php:8.5-cli (app at /app)');
execFileSync('docker', [
	'run', '--rm',
	'-v', `${appDir}:/app`,
	'-v', `${resolve(here, 'bake.php')}:/bake.php:ro`,
	'-e', 'TZ=UTC',
	'-w', '/app',
	'php:8.5-cli',
	'php', '/bake.php',
], { stdio: 'inherit' });

// Tier epochs: sources < livewire intermediates < final artifacts. Five-year
// gaps absorb DOS-time quantization and timezone drift.
const touch = (stamp, paths) => {
	const existing = paths.filter((p) => existsSync(p));
	if (!existing.length) return;
	execFileSync('bash', ['-c',
		`export TZ=UTC; find ${existing.map((p) => `'${p}'`).join(' ')} -exec touch -t ${stamp} {} +`,
	], { stdio: 'inherit' });
};

console.error('[bake] applying mtime tiers');
touch('202001010000', [appDir]);
touch('202501010000', [
	`${appDir}/storage/framework/views/livewire/views`,
	`${appDir}/storage/framework/views/livewire/scripts`,
	`${appDir}/storage/framework/views/livewire/styles`,
	`${appDir}/storage/framework/views/livewire/placeholders`,
]);
touch('203001010000', [
	`${appDir}/storage/framework/views`,
	`${appDir}/bootstrap/cache`,
]);
// The tier-2 pass re-stamped the livewire subdirs; restore tier 1 beneath it.
touch('202501010000', [
	`${appDir}/storage/framework/views/livewire/views`,
	`${appDir}/storage/framework/views/livewire/scripts`,
	`${appDir}/storage/framework/views/livewire/styles`,
	`${appDir}/storage/framework/views/livewire/placeholders`,
]);
touch('203001010000', [`${appDir}/storage/framework/views/livewire/classes`]);

console.error('[bake] done');
