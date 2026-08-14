import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBindingsHandler, shardIndexFor } from '../src/bindings.mjs';
import { toBase64 } from '../src/contracts.mjs';

const fixtures = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../contracts/bindings-cases.json'),
));

test('djb2 shard indices are pinned by the contract fixtures', () => {
  for (const { key, shard } of fixtures.djb2Shards.cases) {
    assert.equal(shardIndexFor(key), shard, key);
  }
});

test('kv put clamps TTL exactly as the fixtures demand', async () => {
  const puts = [];
  const env = {
    KV: {
      put: async (key, value, options) => void puts.push(options?.expirationTtl ?? null),
      get: async () => null,
      delete: async () => undefined,
    },
  };
  const handler = createBindingsHandler(env, { kvBinding: 'KV' });
  for (const { requested } of fixtures.kvTtlClamp) {
    await handler({ kind: 'kv', op: 'put', args: { key: 'k', value: 'v', ttl: requested } });
  }
  assert.deepEqual(puts, fixtures.kvTtlClamp.map((c) => c.stored));
});

test('docache ops route to the hash-pinned shard', async () => {
  const touched = [];
  const shardStub = { get: async () => null, increment: async () => 1 };
  const env = {
    HUB: {
      idFromName: (name) => name,
      get: (name) => (touched.push(name), shardStub),
    },
  };
  const handler = createBindingsHandler(env, { cacheHubBinding: 'HUB' });
  for (const { key, shard } of fixtures.djb2Shards.cases) {
    await handler({ kind: 'docache', op: 'get', args: { key } });
    assert.equal(touched.pop(), `shard-${shard}`, key);
  }
});

test('r2 get answers the contracted shape with base64 body', async () => {
  const bytes = new Uint8Array([1, 2, 3, 250]);
  const env = {
    R2: {
      get: async (key) => (key === 'exists' ? {
        arrayBuffer: async () => bytes.buffer,
        size: bytes.length,
        httpEtag: '"abc"',
        uploaded: new Date('2026-01-02T03:04:05Z'),
        httpMetadata: { contentType: 'image/png' },
      } : null),
    },
  };
  const handler = createBindingsHandler(env, { r2Binding: 'R2' });
  assert.equal(await handler({ kind: 'r2', op: 'get', args: { key: 'missing' } }), null);
  assert.deepEqual(await handler({ kind: 'r2', op: 'get', args: { key: 'exists' } }), {
    body: toBase64(bytes),
    size: 4,
    etag: '"abc"',
    uploaded: '2026-01-02T03:04:05.000Z',
    contentType: 'image/png',
  });
});

test('unconfigured bindings and unknown kinds throw', async () => {
  const handler = createBindingsHandler({}, {});
  await assert.rejects(() => handler({ kind: 'kv', op: 'get', args: {} }), /no KV binding/);
  await assert.rejects(() => handler({ kind: 'docache', op: 'get', args: {} }), /no CacheHub binding/);
  await assert.rejects(() => handler({ kind: 'r2', op: 'get', args: {} }), /no R2 binding/);
  await assert.rejects(() => handler({ kind: 'nope', op: 'x' }), /unknown binding kind/);
});
