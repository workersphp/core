// Pure argv parsing and syntactic validation. Filesystem and network checks
// belong to the orchestrator, not here.
import { UsageError, USAGE } from './constants.mjs';

export function parseArgs(argv) {
	const args = [...argv];
	const command = args.shift();

	const flag = (name) => {
		const i = args.indexOf(`--${name}`);
		return i >= 0 ? args[i + 1] : undefined;
	};
	const flagAll = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
	const has = (name) => args.includes(`--${name}`);

	if (command !== 'deploy' || !flag('app') || !flag('name')) {
		throw new UsageError(USAGE);
	}

	const name = flag('name');
	if (!/^[a-z0-9-]+$/.test(name)) {
		throw new UsageError(`worker name must be lowercase alphanumeric/dashes: ${name}`);
	}

	const emailFrom = flag('email');
	if (emailFrom && !emailFrom.includes('@')) {
		throw new UsageError(`--email expects a from address, got: ${emailFrom}`);
	}

	return {
		app: flag('app'),
		name,
		d1Name: flag('d1'),
		emailFrom,
		queueName: flag('queue'),
		crons: flagAll('cron'),
		useBroadcast: has('broadcast'),
		r2Bucket: flag('r2'),
		kvNamespace: flag('kv'),
		customDomain: flag('domain'),
		// Which vendored PHP binary the worker imports (and the opcache bake
		// runs). Default = the production binary: JSPI + wasm exceptions +
		// cfbindings.
		wasmVariant: flag('wasm') || 'php-wasm-85-jspi',
		extraEnv: Object.fromEntries(
			flagAll('env').map((pair) => {
				const eq = pair.indexOf('=');
				return [pair.slice(0, eq), pair.slice(eq + 1)];
			}),
		),
		out: flag('out'),
		bake: has('bake'),
		noDeploy: has('no-deploy'),
	};
}
