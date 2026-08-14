// Handler behind the cfbindings extension's single async entry point.
// Binding names in requests are ignored on purpose: the runtime maps each
// kind to its configured binding, so PHP can never reach an arbitrary one.
import { toBase64, fromBase64 } from './contracts.mjs';

export const DOCACHE_SHARDS = 16;

// djb2-xor. Pinned by contract fixtures: changing this function moves keys
// between shards and strands live Durable Object state.
export const shardIndexFor = (key) => {
	let h = 5381;
	for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
	return h % DOCACHE_SHARDS;
};

export const createBindingsHandler = (env, { kvBinding, r2Binding, cacheHubBinding }) =>
	async ({ kind, op, args = {} }) => {
		if (kind === 'kv') {
			const kv = kvBinding && env[kvBinding];
			if (!kv) throw new Error('no KV binding configured');
			switch (op) {
				case 'get': return await kv.get(args.key, 'text');
				case 'put': return await kv.put(args.key, args.value, args.ttl ? { expirationTtl: Math.max(60, args.ttl) } : undefined) ?? true;
				case 'delete': return await kv.delete(args.key) ?? true;
				default: throw new Error(`unknown kv op: ${op}`);
			}
		}
		if (kind === 'docache') {
			const ns = cacheHubBinding && env[cacheHubBinding];
			if (!ns) throw new Error('no CacheHub binding configured');
			const shardFor = (key) => ns.get(ns.idFromName(`shard-${shardIndexFor(key)}`));
			switch (op) {
				case 'get': return await shardFor(args.key).get(args.key);
				case 'put': return await shardFor(args.key).put(args.key, args.value, args.ttl ?? 0);
				case 'forget': return await shardFor(args.key).forget(args.key);
				case 'increment': return await shardFor(args.key).increment(args.key, args.by ?? 1);
				case 'lock': return await shardFor(args.key).lock(args.key, args.owner, args.ttl ?? 0);
				case 'unlock': return await shardFor(args.key).unlock(args.key, args.owner ?? null);
				case 'lockOwner': return await shardFor(args.key).lockOwner(args.key);
				case 'flush': {
					for (let i = 0; i < DOCACHE_SHARDS; i++) {
						await ns.get(ns.idFromName(`shard-${i}`)).flush();
					}
					return true;
				}
				default: throw new Error(`unknown docache op: ${op}`);
			}
		}
		if (kind === 'r2') {
			const r2 = r2Binding && env[r2Binding];
			if (!r2) throw new Error('no R2 binding configured');
			switch (op) {
				case 'get': {
					const object = await r2.get(args.key);
					if (!object) return null;
					const bytes = new Uint8Array(await object.arrayBuffer());
					return { body: toBase64(bytes), size: object.size, etag: object.httpEtag, uploaded: object.uploaded?.toISOString?.() ?? null, contentType: object.httpMetadata?.contentType ?? null };
				}
				case 'head': {
					const object = await r2.head(args.key);
					return object ? { size: object.size, etag: object.httpEtag, uploaded: object.uploaded?.toISOString?.() ?? null, contentType: object.httpMetadata?.contentType ?? null } : null;
				}
				case 'put':
					await r2.put(args.key, fromBase64(args.body ?? ''), args.contentType ? { httpMetadata: { contentType: args.contentType } } : undefined);
					return true;
				case 'delete': return await r2.delete(args.keys ?? args.key) ?? true;
				case 'list': {
					const listed = await r2.list({ prefix: args.prefix ?? undefined, cursor: args.cursor ?? undefined, delimiter: args.delimiter ?? undefined });
					return {
						objects: listed.objects.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded?.toISOString?.() ?? null })),
						delimitedPrefixes: listed.delimitedPrefixes ?? [],
						truncated: listed.truncated ?? false,
						cursor: listed.truncated ? listed.cursor : null,
					};
				}
				default: throw new Error(`unknown r2 op: ${op}`);
			}
		}
		throw new Error(`unknown binding kind: ${kind}`);
	};
