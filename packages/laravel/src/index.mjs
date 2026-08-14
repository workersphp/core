// The Laravel adapter for the Workers PHP runtime, plus the createLaravelWorker
// convenience wrapper most deployments use. The adapter object is the entire
// framework-specific surface — the runtime never imports Laravel knowledge.
import { PhpBase as DefaultPhpBase } from '../../runtime/src/phpbase/PhpBase.mjs';
import { createPhpWorker } from '../../runtime/src/worker.mjs';
import { DEFAULT_ENV, WARMUP, requestScript, jobScript, scheduleScript } from './scripts.mjs';

// Livewire 4 hashes its endpoint prefix from APP_KEY, which the secret-free
// bake cannot know, so the packer publishes the script under /__livewire/ and
// the runtime treats the hash as a wildcard. One constant pair, two consumers:
// this adapter's asset rewrite and the CLI's asset publisher.
export const LIVEWIRE_ASSET_ROUTE = /^\/livewire-[0-9a-f]+\/(livewire[\w.-]*\.js(?:\.map)?)$/;
export const LIVEWIRE_CANONICAL_PREFIX = '/__livewire/';

/**
 * @param {object} [options]
 * @param {(env: object) => object} [options.envVars]  Extra/overriding Laravel
 *   .env values; APP_KEY is always taken from the APP_KEY Worker secret.
 * @param {(env: object) => object} [options.configOverrides]  Dotted config keys
 *   patched in the moment config loads (baked config caches ship dummy values).
 */
export function laravelAdapter({ envVars, configOverrides } = {}) {
	return {
		name: 'laravel',
		docroot: '/app/public',

		prepareBoot({ FS, env, encoder }) {
			if (!env.APP_KEY) {
				throw new Error('APP_KEY secret is not set (wrangler secret put APP_KEY, or .dev.vars locally)');
			}
			const vars = { ...DEFAULT_ENV, APP_KEY: env.APP_KEY, ...(envVars ? envVars(env) : {}) };
			const dotenv = Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
			FS.writeFile('/app/.env', encoder.encode(dotenv));
		},

		// Baked apps ship compiled views + config cache in the zip; the boot
		// warmup only exists for apps packed without the bake step.
		needsWarmup: (zipfs) => !zipfs.files.has('bootstrap/cache/config.php'),
		warmupScript: WARMUP,

		// Baked config caches ship with dummy secrets (the zip is secret-free);
		// real values are patched into config the moment it loads.
		secrets: (env) => ({
			'app.key': env.APP_KEY,
			...(configOverrides ? configOverrides(env) : {}),
		}),

		requestScript,
		jobScript,
		scheduleScript,

		rewriteAssetRequest(url, request) {
			const livewireJs = url.pathname.match(LIVEWIRE_ASSET_ROUTE);
			return livewireJs
				? new Request(new URL(LIVEWIRE_CANONICAL_PREFIX + livewireJs[1], url), request)
				: null;
		},
	};
}

/**
 * Create a Worker handler object (fetch + queue + scheduled) that serves a
 * packed Laravel app. Signature unchanged from the original LaravelWorkerd
 * runtime; new code may compose createPhpWorker + laravelAdapter directly.
 */
export function createLaravelWorker({ envVars, configOverrides, PhpBaseClass = DefaultPhpBase, ...infra }) {
	return createPhpWorker({
		...infra,
		PhpBaseClass,
		adapter: laravelAdapter({ envVars, configOverrides }),
	});
}
