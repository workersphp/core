// The coordination cache: a sharded Durable Object store for the cache
// operations KV cannot do — atomic increment and real locks. Single-threaded
// execution per object makes read-modify-write atomic with no CAS dance; the
// runtime routes each key to a shard by hash, so one hot counter never
// bottlenecks the rest. TTLs expire lazily on read.
import { DurableObject } from 'cloudflare:workers';

export function createCacheHubClass() {
	return class CacheHub extends DurableObject {
		async #live(key) {
			const entry = await this.ctx.storage.get(key);
			if (entry === undefined) return undefined;
			if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
				await this.ctx.storage.delete(key);
				return undefined;
			}
			return entry;
		}

		async get(key) {
			const entry = await this.#live(key);
			return entry === undefined ? null : entry.value;
		}

		async put(key, value, ttlSeconds) {
			await this.ctx.storage.put(key, {
				value,
				expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
			});
			return true;
		}

		async forget(key) {
			await this.ctx.storage.delete(key);
			return true;
		}

		async flush() {
			await this.ctx.storage.deleteAll();
			return true;
		}

		// Atomic: the object is single-threaded, so no interleaving is possible.
		// Values are tagged by the PHP store ({n: number} | {s: serialized});
		// increment only makes sense over the numeric tag.
		async increment(key, by) {
			const entry = await this.#live(key);
			const current = entry === undefined ? 0 : Number(entry.value?.n ?? 0) || 0;
			const next = current + by;
			await this.ctx.storage.put(key, {
				value: { n: next },
				expiresAt: entry === undefined ? null : entry.expiresAt,
			});
			return next;
		}

		async lock(key, owner, ttlSeconds) {
			const existing = await this.#live(`lock:${key}`);
			if (existing !== undefined && existing.value !== owner) {
				return false;
			}
			await this.ctx.storage.put(`lock:${key}`, {
				value: owner,
				expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
			});
			return true;
		}

		async unlock(key, owner) {
			const existing = await this.#live(`lock:${key}`);
			if (existing === undefined) return true;
			if (existing.value !== owner && owner !== null) return false;
			await this.ctx.storage.delete(`lock:${key}`);
			return true;
		}

		async lockOwner(key) {
			const existing = await this.#live(`lock:${key}`);
			return existing === undefined ? null : existing.value;
		}
	};
}
