// Cloudflare resource provisioning: four near-identical shapes — shell out
// to wrangler, tolerate the already-exists race, scrape an id when the
// binding needs one.
import { spawnSync } from 'node:child_process';
import { log } from './constants.mjs';

const wrangler = (args, cwd) => spawnSync('npx', ['wrangler', ...args], { cwd, encoding: 'utf8' });

export function provision(options, cwd) {
	const { d1Name, queueName, r2Bucket, kvNamespace } = options;
	let d1Id = null;
	let kvId = null;

	if (d1Name) {
		const d1Json = (cmd) => wrangler(['d1', cmd, d1Name, '--json'], cwd);
		// The info call flakes occasionally; a flake must not cascade into a
		// create attempt that dies on "already exists".
		let info = d1Json('info');
		if (info.status !== 0) info = d1Json('info');
		if (info.status !== 0) {
			log(`creating D1 database ${d1Name}`);
			const created = wrangler(['d1', 'create', d1Name], cwd);
			if (created.status !== 0 && !/already exists/i.test((created.stderr || '') + (created.stdout || ''))) {
				throw new Error(created.stderr || created.stdout);
			}
			info = d1Json('info');
		}
		d1Id = JSON.parse(info.stdout).uuid;
		log(`D1: ${d1Name} (${d1Id})`);
	}

	if (queueName) {
		const created = wrangler(['queues', 'create', queueName], cwd);
		// Cloudflare says 'already taken', not 'already exists', for queues.
		if (created.status !== 0 && !/already (exists|taken)/i.test((created.stderr || '') + (created.stdout || ''))) {
			throw new Error(created.stderr || created.stdout);
		}
		log(`queue: ${queueName}`);
	}

	if (r2Bucket) {
		const created = wrangler(['r2', 'bucket', 'create', r2Bucket], cwd);
		if (created.status !== 0 && !/already (exists|taken|own)/i.test((created.stderr || '') + (created.stdout || ''))) {
			throw new Error(created.stderr || created.stdout);
		}
		log(`r2 bucket: ${r2Bucket}`);
	}

	if (kvNamespace) {
		const list = wrangler(['kv', 'namespace', 'list'], cwd);
		const existing = (() => {
			try {
				return JSON.parse(list.stdout).find((ns) => ns.title === kvNamespace);
			} catch {
				return null;
			}
		})();
		if (existing) {
			kvId = existing.id;
		} else {
			const created = wrangler(['kv', 'namespace', 'create', kvNamespace], cwd);
			const match = (created.stdout || '').match(/"id":\s*"([0-9a-f]+)"/);
			if (!match) {
				throw new Error(created.stderr || created.stdout);
			}
			kvId = match[1];
		}
		log(`kv namespace: ${kvNamespace} (${kvId})`);
	}

	return { d1Id, kvId };
}
