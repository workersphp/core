// The deploy orchestrator: parse -> validate environment -> provision ->
// codegen -> write -> pack/bake -> publish assets -> secrets -> deploy.
// Single exit path; every stage throws on failure.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseArgs } from './args.mjs';
import { generate } from './codegen.mjs';
import { provision } from './provision.mjs';
import { packApp, bakeOpcache } from './build.mjs';
import { publishAssets } from './assets.mjs';
import { wranglerFor, ensureAppKey, deploy } from './deploy.mjs';
import { UsageError, log } from './constants.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export async function main(argv) {
	let options;
	try {
		options = parseArgs(argv);
	} catch (error) {
		if (error instanceof UsageError) {
			console.error(error.message);
			return 1;
		}
		throw error;
	}

	const appDir = resolve(options.app);
	if (!existsSync(appDir + '/artisan')) {
		console.error(`${appDir} does not look like a Laravel app (no artisan)`);
		return 1;
	}
	if (options.wasmVariant === 'php-wasm-85-jspi') {
		// Resolved like the generated worker will resolve it: through node's
		// module resolution, so monorepo symlinks and npm installs both work.
		try {
			createRequire(import.meta.url).resolve('@workersphp/php-wasm-jspi/php8.5-web.mjs.wasm');
		} catch {
			console.error('cannot resolve @workersphp/php-wasm-jspi — install it (or run tools/ensure-binaries.mjs in the monorepo)');
			return 1;
		}
	} else if (!existsSync(resolve(repoRoot, 'packages/runtime/vendor', options.wasmVariant, 'php8.5-web.mjs.wasm'))) {
		console.error(`unknown --wasm variant: ${options.wasmVariant} (no packages/runtime/vendor/${options.wasmVariant}/)`);
		return 1;
	}

	// Deployments scaffold under the caller's cwd; the generated worker's bare
	// @workersphp/* imports must resolve from there, so run the CLI from a
	// directory whose node_modules carries the packages (the app itself, with
	// the CLI installed as a dev dependency, or the monorepo root).
	const deployDir = options.out
		? resolve(options.out)
		: resolve(process.cwd(), 'deployments', options.name);

	let schemaPath = null;
	try {
		schemaPath = relative(deployDir, createRequire(join(process.cwd(), 'noop.js')).resolve('wrangler/config-schema.json'));
	} catch {
		// No local wrangler install: omit the editor-only $schema hint.
	}

	const ids = provision(options, process.cwd());
	const { workerSource, wranglerConfig } = generate(options, {
		...ids,
		accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? null,
		schemaPath,
	});

	mkdirSync(deployDir + '/src', { recursive: true });
	mkdirSync(deployDir + '/assets', { recursive: true });
	writeFileSync(deployDir + '/src/index.mjs', workerSource);
	writeFileSync(deployDir + '/wrangler.jsonc', JSON.stringify(wranglerConfig, null, 2) + '\n');
	log(`scaffolded ${relative(repoRoot, deployDir)}`);

	packApp({ appDir, deployDir, bake: options.bake });
	if (options.bake) {
		bakeOpcache({ deployDir, wasmVariant: options.wasmVariant });
	}
	publishAssets({ appDir, deployDir });

	const wrangler = wranglerFor(deployDir, process.cwd());
	ensureAppKey(deployDir, wrangler);

	if (options.noDeploy) {
		log('--no-deploy: stopping before deploy');
		return 0;
	}

	deploy(wrangler);
	if (options.emailFrom) {
		const domain = options.emailFrom.split('@')[1];
		log(`mail sends from ${options.emailFrom} — the domain must be onboarded once:`);
		log(`  npx wrangler email sending enable ${domain}`);
	}
	log(`done — https://${options.name}.<your-subdomain>.workers.dev`);
	return 0;
}
