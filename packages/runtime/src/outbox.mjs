// The outbox engine: PHP writes JSON files into /tmp outbox directories
// during a run; the runtime drains them afterwards and hands the entries to
// the configured transports. Drain happens synchronously at call time so the
// caller can ride the actual sends on ctx.waitUntil.
import { decoder, OUTBOX } from './contracts.mjs';
import { STATIC_TYPES } from './static.mjs';

export const drainDir = (module, dir) => {
	if (!module.FS.analyzePath(dir).exists) return [];
	const entries = [];
	for (const entry of module.FS.readdir(dir)) {
		if (entry === '.' || entry === '..') continue;
		const path = `${dir}/${entry}`;
		try {
			entries.push(JSON.parse(decoder.decode(module.FS.readFile(path))));
		} finally {
			module.FS.unlink(path);
		}
	}
	return entries;
};

// Mail and queue outboxes are flushed after every PHP run — requests AND
// jobs (jobs may send mail or dispatch further jobs). The R2 staging sweep
// runs BEFORE the broadcast fan-out: receivers fetch object URLs the instant
// a broadcast lands, and R2 is read-after-write once the put resolves.
export const flushOutboxes = async ({ php, env, onMail, onQueue, r2Binding, broadcastBinding }) => {
	const module = await php.binary;
	const mail = drainDir(module, OUTBOX.mail);
	if (mail.length) {
		if (onMail) {
			await onMail(env, mail);
		} else {
			console.log(`[mail] ${mail.length} outbox message(s) dropped — no onMail handler configured`);
		}
	}
	const jobs = drainDir(module, OUTBOX.queue);
	if (jobs.length) {
		if (onQueue) {
			await onQueue(env, jobs);
		} else {
			console.log(`[queue] ${jobs.length} outbox job(s) dropped — no onQueue handler configured`);
		}
	}
	if (r2Binding && env[r2Binding] && module.FS.analyzePath(OUTBOX.r2Staging).exists) {
		const staged = [];
		const walk = (dir, prefix) => {
			for (const entry of module.FS.readdir(dir)) {
				if (entry === '.' || entry === '..') continue;
				const path = `${dir}/${entry}`;
				const key = prefix ? `${prefix}/${entry}` : entry;
				if (module.FS.isDir(module.FS.stat(path).mode)) {
					walk(path, key);
				} else {
					staged.push({ path, key });
				}
			}
		};
		walk(OUTBOX.r2Staging, '');
		for (const { path, key } of staged) {
			const bytes = module.FS.readFile(path);
			const extension = key.split('.').pop().toLowerCase();
			await env[r2Binding].put(key, bytes, {
				httpMetadata: { contentType: STATIC_TYPES[extension] ?? 'application/octet-stream' },
			});
			module.FS.unlink(path);
		}
		if (staged.length) {
			console.log(`[r2] flushed ${staged.length} staged object(s)`);
		}
	}
	const broadcasts = drainDir(module, OUTBOX.broadcast);
	if (broadcasts.length) {
		if (broadcastBinding && env[broadcastBinding]) {
			const ns = env[broadcastBinding];
			const { delivered } = await ns.get(ns.idFromName('hub')).publish(broadcasts);
			console.log(`[broadcast] ${broadcasts.length} event(s), ${delivered} frame(s) delivered`);
		} else {
			console.log(`[broadcast] ${broadcasts.length} event(s) dropped — no broadcastBinding configured`);
		}
	}
};
