// Build orchestration: pack the app zip (Laravel tooling) and optionally
// bake the OPcache file cache under the exact wasm binary the worker runs.
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './constants.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const laravelBuild = resolve(here, '../../laravel/build');
const runtimeTools = resolve(here, '../../runtime/tools');

export function packApp({ appDir, deployDir, bake }) {
	log('packing app');
	execFileSync('node', [
		resolve(laravelBuild, 'pack.mjs'), appDir, deployDir + '/assets/app.zip',
		...(bake ? ['--bake'] : []),
	], { stdio: ['inherit', 'inherit', 'inherit'] });
}

export function bakeOpcache({ deployDir, wasmVariant }) {
	log('baking opcache file cache');
	execFileSync('node', [
		// JSPI-wrapped exports need the JSPI API in the baking Node too (24+).
		...(wasmVariant.includes('jspi') ? ['--experimental-wasm-jspi'] : []),
		resolve(runtimeTools, 'bake-opcache.mjs'),
		deployDir + '/assets/app.zip',
		deployDir + '/assets/opcache.zip',
		wasmVariant,
	], { stdio: ['inherit', 'inherit', 'inherit'] });
}
