// The framework-agnostic Workers PHP runtime: a resident PHP-in-wasm
// interpreter per isolate, app delivered as a secret-free zip via Static
// Assets, with queue/cron entry points and Cloudflare-primitive plumbing
// (outboxes, cfbindings, Durable Object hubs). Request flow architecture
// after togishima/laravel-edge (MIT).
//
// Everything framework-shaped arrives through an ADAPTER — a plain object
// that renders the PHP scripts the runtime executes and describes the app's
// layout. The Laravel adapter is the first; the interface is what a Drupal
// adapter would implement without touching this file.
//
// Adapter interface:
//   name             string, for logs
//   docroot          e.g. '/app/public' — MEMFS static serving root
//   prepareBoot({ FS, env })   write framework boot files (e.g. /app/.env);
//                              throw to fail the boot loudly
//   needsWarmup(zipfs)         boolean — run warmupScript after mount?
//   warmupScript     string | null
//   secrets(env)     opaque per-run payload injected as meta.secrets
//   requestScript(meta)        PHP source answering one HTTP request
//   jobScript(meta) | null     PHP source running one queue payload
//   scheduleScript(meta) | null  PHP source running due scheduled work
//   rewriteAssetRequest?(url, request)  Request | null — one routing hook
//                              for framework asset conventions
import { encoder, fromBase64, extractEnvelope } from './contracts.mjs';
import { serveStatic, isPrivateBundlePath } from './static.mjs';
import { createBindingsHandler } from './bindings.mjs';
import { flushOutboxes } from './outbox.mjs';
import { createPhp, runPhp } from './php.mjs';
import { mountZip } from './ZipFS.mjs';

export function createPhpWorker({
	loader,
	wasm,
	adapter,
	zipAsset = 'app.zip',
	appFiles,
	PhpBaseClass,
	phpBindings,
	ini = '',
	onMail,
	onQueue,
	broadcastBinding,
	r2Binding,
	kvBinding,
	cacheHubBinding,
	websocketPrefix = '/app/',
	r2PublicPrefix = '/storage/',
}) {
	let phpPromise = null;
	let chain = Promise.resolve();
	let queueDepth = 0;

	// One interpreter per isolate means requests serialize; a burst pinned to
	// this isolate must fail fast rather than convoy into minutes of queue.
	// Cloudflare retries elsewhere / the client backs off, and fresh isolates
	// absorb the load — that is the scaling model working, not failing.
	const MAX_QUEUE_DEPTH = 20;

	const enqueue = (callback) => {
		if (queueDepth >= MAX_QUEUE_DEPTH) {
			const busy = new Error('isolate request queue is full');
			busy.busy = true;
			return Promise.reject(busy);
		}
		queueDepth++;
		const run = () => callback();
		const result = chain.then(run, run);
		chain = result.then(() => undefined, () => undefined).finally(() => queueDepth--);
		return result;
	};

	const flush = (env, php) =>
		flushOutboxes({ php, env, onMail, onQueue, r2Binding, broadcastBinding });

	const createPhpForEnv = (env, hasBakedOpcache) => createPhp({
		PhpBaseClass,
		loader,
		wasm,
		ini,
		hasBakedOpcache,
		moduleArgs: {
			...(phpBindings ? phpBindings(env) : {}),
			cfbindings: createBindingsHandler(env, { kvBinding, r2Binding, cacheHubBinding }),
		},
	});

	const bootPhp = async (env) => {
		// The app arrives either as a zip via Static Assets (real deployments)
		// or as an inline appFiles tree (examples, tests — no assets binding).
		let zipBytes = null;
		let opcacheBytes = null;
		if (env.ASSETS) {
			const zipRes = await env.ASSETS.fetch('https://assets.local/' + zipAsset);
			if (!zipRes.ok) {
				throw new Error(`${zipAsset} asset fetch failed: ${zipRes.status}`);
			}
			zipBytes = new Uint8Array(await zipRes.arrayBuffer());

			// Optional pre-baked OPcache file cache (bake-opcache.mjs).
			const opcacheRes = await env.ASSETS.fetch('https://assets.local/opcache.zip');
			if (opcacheRes.ok) {
				opcacheBytes = new Uint8Array(await opcacheRes.arrayBuffer());
			}
		} else if (!appFiles) {
			throw new Error('no ASSETS binding and no appFiles — nothing to serve');
		}

		const php = createPhpForEnv(env, opcacheBytes !== null);
		let bootLog = '';
		const collect = (e) => (bootLog += e.detail);
		php.addEventListener('output', collect);
		php.addEventListener('error', collect);

		const module = await php.binary;
		if (opcacheBytes) {
			// Mounted over /tmp: OPcache stats its cache dir during pib_init, and
			// /tmp is the one directory guaranteed to exist that early. ZipFS
			// accepts the runtime's stray /tmp writes via copy-on-write nodes.
			const opfs = mountZip(module.FS, opcacheBytes, '/tmp');
			console.log(`boot: mounted opcache cache (${opfs.stats().entries} entries, lazy)`);
		}
		// Symfony's PhpExecutableFinder shells out to locate PHP (fork — which
		// wasm cannot do, and the failure aborts route loading for any app that
		// schedules a CLI command). getenv('PHP_BINARY') pointing at an
		// executable file short-circuits it; the stub is never executed. Kept in
		// the runtime: any Symfony-component consumer (Drupal included) hits it.
		module.FS.mkdirTree('/usr/bin');
		module.FS.writeFile('/usr/bin/php', '#!/bin/false\n');
		module.FS.chmod('/usr/bin/php', 0o755);
		// Lazy zip-backed FS: no extraction, ~10 MB resident zip, content hydrated
		// per file on first read and LRU-evicted. Writes (sessions, lazy compiles,
		// boot files) promote nodes to owned in-memory buffers.
		let zipfs = null;
		if (zipBytes) {
			zipfs = mountZip(module.FS, zipBytes, '/app');
			console.log(`boot: mounted zip (${zipfs.stats().entries} entries, lazy)`);
		}
		if (appFiles) {
			for (const [path, content] of Object.entries(appFiles)) {
				module.FS.mkdirTree(path.slice(0, path.lastIndexOf('/')) || '/');
				module.FS.writeFile(path, typeof content === 'string' ? encoder.encode(content) : content);
			}
		}
		await adapter.prepareBoot({ FS: module.FS, env, encoder });
		await php.refresh();
		if (adapter.warmupScript && (zipfs ? adapter.needsWarmup(zipfs) : true)) {
			await runPhp(php, adapter.warmupScript);
		} else {
			console.log('boot: warmup skipped');
		}
		php.removeEventListener('output', collect);
		php.removeEventListener('error', collect);
		console.log('boot:', bootLog.trim());
		return php;
	};

	const bootedPhp = async (env) => {
		phpPromise ??= bootPhp(env);
		try {
			return await phpPromise;
		} catch (error) {
			phpPromise = null;
			throw error;
		}
	};

	const handle = async (request, env, ctx) => {
		const php = await bootedPhp(env);
		const url = new URL(request.url);

		const staticResponse = serveStatic(await php.binary, url.pathname, adapter.docroot);
		if (staticResponse) return staticResponse;

		let stdout = '';
		let stderr = '';
		const onOut = (e) => (stdout += e.detail);
		const onErr = (e) => (stderr += e.detail);
		php.addEventListener('output', onOut);
		php.addEventListener('error', onErr);

		try {
			await php.refresh();
			const bodyBytes = new Uint8Array(await request.arrayBuffer());
			if (bodyBytes.length) {
				await php.writeFile('/req.body', bodyBytes);
			}
			const meta = {
				method: request.method,
				uri: url.pathname + url.search,
				scheme: url.protocol.replace(':', ''),
				host: url.host,
				hostname: url.hostname,
				port: url.port || (url.protocol === 'https:' ? '443' : '80'),
				headers: Object.fromEntries(request.headers),
				remoteAddr: request.headers.get('cf-connecting-ip') ?? '127.0.0.1',
				secrets: adapter.secrets(env),
			};
			await runPhp(php, adapter.requestScript(meta));
			php.flush();
		} finally {
			php.removeEventListener('output', onOut);
			php.removeEventListener('error', onErr);
		}

		if (stderr) {
			console.log('[php stderr]', stderr.slice(0, 2000));
		}

		// The response must not wait for queue/mail/R2 delivery: drain happens
		// synchronously on call, the sends ride waitUntil after the response.
		const flushing = flush(env, php);
		if (ctx?.waitUntil) {
			ctx.waitUntil(flushing);
		} else {
			await flushing;
		}
		const module = await php.binary;

		const envelope = extractEnvelope(stdout);
		if (!envelope) {
			console.log('[php stdout without envelope]', stdout.slice(0, 2000));
			return new Response('PHP did not produce a response envelope', { status: 500 });
		}
		if (envelope.metrics) {
			// USE_ZEND_ALLOC=0 in this build → PHP-side memory counters read 0; the
			// number that matters for the isolate is the wasm linear-memory high-water
			// mark (it never shrinks) plus MEMFS bytes in the JS heap.
			const linearMb = (module.HEAPU8.length / 1048576).toFixed(1);
			console.log(
				`[metrics] ${request.method} ${url.pathname} linear=${linearMb}MB files=${envelope.metrics.files}`,
			);
		}
		const headers = new Headers();
		for (const [name, values] of Object.entries(envelope.headers)) {
			for (const value of values) {
				headers.append(name, value);
			}
		}
		for (const cookie of envelope.cookies) {
			headers.append('Set-Cookie', cookie);
		}
		return new Response(fromBase64(envelope.body), { status: envelope.status, headers });
	};

	// Shared runner for non-HTTP entries (jobs, schedule): boot if needed,
	// refresh, run the script, flush outboxes, parse the envelope.
	const runManagement = async (env, script) => {
		const php = await bootedPhp(env);
		let stdout = '';
		let stderr = '';
		const onOut = (e) => (stdout += e.detail);
		const onErr = (e) => (stderr += e.detail);
		php.addEventListener('output', onOut);
		php.addEventListener('error', onErr);
		try {
			await php.refresh();
			await runPhp(php, script);
		} finally {
			php.removeEventListener('output', onOut);
			php.removeEventListener('error', onErr);
		}
		if (stderr) {
			console.log('[php stderr]', stderr.slice(0, 2000));
		}
		await flush(env, php);
		const envelope = extractEnvelope(stdout);
		if (!envelope) {
			throw new Error('PHP produced no envelope: ' + stdout.slice(0, 500));
		}
		return envelope;
	};

	return {
		async fetch(request, env, ctx) {
			// WebSocket upgrades under the configured prefix go straight to the
			// BroadcastHub DO — PHP is never involved in the socket path.
			if (broadcastBinding
				&& request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
				&& new URL(request.url).pathname.startsWith(websocketPrefix)) {
				const ns = env[broadcastBinding];
				return ns.get(ns.idFromName('hub')).fetch(request);
			}
			// Uploaded objects stream straight from R2; PHP never serves a byte.
			if (r2Binding && (request.method === 'GET' || request.method === 'HEAD')) {
				const storagePath = new URL(request.url).pathname;
				if (storagePath.startsWith(r2PublicPrefix)) {
					const object = await env[r2Binding].get(decodeURIComponent(storagePath.slice(r2PublicPrefix.length)));
					if (object) {
						const headers = new Headers({
							'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
							'cache-control': 'public, max-age=31536000, immutable',
							etag: object.httpEtag,
						});
						return new Response(request.method === 'HEAD' ? null : object.body, { headers });
					}
					// Miss falls through: the app may serve the path itself.
				}
			}
			// Process-model split: anything Static Assets can serve must never touch
			// PHP. Asset-only isolates then never boot the runtime at all (boot is
			// lazy), which is most of the fleet under real traffic.
			if (env.ASSETS && (request.method === 'GET' || request.method === 'HEAD')) {
				const url = new URL(request.url);
				if (!isPrivateBundlePath(url.pathname)) {
					const rewritten = adapter.rewriteAssetRequest?.(url, request) ?? null;
					const asset = await env.ASSETS.fetch(rewritten ?? request);
					// 304s count: conditional revalidations (If-None-Match) must not
					// fall through and boot PHP for a byte-identical answer.
					if (asset.status === 200 || asset.status === 304) {
						return asset;
					}
				}
			}
			return enqueue(() => handle(request, env, ctx)).catch((error) => {
				if (error.busy) {
					return new Response('Server busy, retry shortly', {
						status: 503,
						headers: { 'retry-after': '2' },
					});
				}
				throw error;
			});
		},

		// Cloudflare Queues consumer: each message carries one framework payload
		// (produced by the outbox flush). Serialized through the same chain as
		// requests — one wasm linear memory, one execution at a time.
		async queue(batch, env) {
			if (!adapter.jobScript) {
				throw new Error(`adapter '${adapter.name}' has no job runner`);
			}
			for (const message of batch.messages) {
				try {
					const body = typeof message.body === 'string' ? JSON.parse(message.body) : message.body;
					const envelope = await enqueue(() =>
						runManagement(env, adapter.jobScript({
							payload: body.payload ?? JSON.stringify(body),
							queue: body.queue ?? batch.queue,
							secrets: adapter.secrets(env),
						})),
					);
					if (!envelope.ok) {
						throw new Error(envelope.error);
					}
					message.ack();
				} catch (error) {
					console.log(`[queue] job failed (${message.id}): ${error.message}`);
					message.retry();
				}
			}
		},

		// Cron Triggers: run due scheduled work in-process (never a CLI fork).
		async scheduled(event, env) {
			if (!adapter.scheduleScript) {
				throw new Error(`adapter '${adapter.name}' has no scheduler`);
			}
			const envelope = await enqueue(() =>
				runManagement(env, adapter.scheduleScript({ secrets: adapter.secrets(env) })),
			);
			if (!envelope.ok) {
				throw new Error(`[schedule] ${envelope.error}`);
			}
			console.log(`[schedule] ran=${envelope.ran} skipped=${envelope.skipped} failed=${envelope.failed}`);
		},
	};
}
