// Wrangler invocation against the scaffolded config, plus the APP_KEY secret
// lifecycle (dev + deployed; generated keys are never printed).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { log } from './constants.mjs';

export const wranglerFor = (deployDir, cwd) => (wranglerArgs, opts = {}) =>
	spawnSync('npx', ['wrangler', ...wranglerArgs, '-c', deployDir + '/wrangler.jsonc'], {
		cwd,
		encoding: 'utf8',
		...opts,
	});

export function ensureAppKey(deployDir, wrangler) {
	const appKey = 'base64:' + randomBytes(32).toString('base64');
	if (!existsSync(deployDir + '/.dev.vars')) {
		writeFileSync(deployDir + '/.dev.vars', `APP_KEY=${appKey}\n`, { mode: 0o600 });
		log('wrote .dev.vars (local dev key)');
	}
	const secretList = wrangler(['secret', 'list']);
	if (!secretList.stdout?.includes('APP_KEY')) {
		log('uploading APP_KEY secret');
		const put = wrangler(['secret', 'put', 'APP_KEY'], { input: appKey });
		if (put.status !== 0) {
			throw new Error(put.stderr || put.stdout);
		}
	}
}

export function deploy(wrangler) {
	log('deploying');
	const result = wrangler(['deploy'], { stdio: ['inherit', 'inherit', 'inherit'] });
	if (result.status !== 0) {
		throw new Error(`wrangler deploy exited ${result.status}`);
	}
}
