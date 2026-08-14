import test from 'node:test';
import assert from 'node:assert/strict';
import { flushOutboxes, drainDir } from '../src/outbox.mjs';

// Minimal in-memory FS speaking the Emscripten FS surface the outbox uses.
function fakeFs(files) {
  const store = new Map(Object.entries(files));
  const encoder = new TextEncoder();
  const dirsOf = (dir) => {
    const names = new Set();
    for (const path of store.keys()) {
      if (path.startsWith(dir + '/')) names.add(path.slice(dir.length + 1).split('/')[0]);
    }
    return names;
  };
  return {
    FS: {
      analyzePath: (dir) => ({ exists: [...store.keys()].some((p) => p.startsWith(dir + '/')) }),
      readdir: (dir) => ['.', '..', ...dirsOf(dir)],
      readFile: (path) => {
        const value = store.get(path);
        return typeof value === 'string' ? encoder.encode(value) : value;
      },
      unlink: (path) => store.delete(path),
      stat: (path) => ({ mode: store.has(path) ? 0o100644 : 0o040755 }),
      isDir: (mode) => (mode & 0o170000) === 0o040000,
    },
    store,
  };
}

test('flush order is mail, queue, R2 sweep, broadcast — and drains everything', async () => {
  const order = [];
  const { FS, store } = fakeFs({
    '/tmp/outbox/m1.json': JSON.stringify({ from: 'a@x', to: ['b@x'], mime: 'raw' }),
    '/tmp/queue-outbox/q1.json': JSON.stringify({ queue: 'default', payload: '{}', delaySeconds: 0 }),
    '/tmp/r2-staging/photos/p.png': new Uint8Array([137, 80]),
    '/tmp/broadcast-outbox/b1.json': JSON.stringify({ channels: ['demo'], event: 'e', data: {}, socket: null }),
  });
  const env = {
    STORAGE: {
      put: async (key, bytes, options) => {
        order.push('r2');
        assert.equal(key, 'photos/p.png');
        assert.equal(options.httpMetadata.contentType, 'image/png');
      },
    },
    HUB: {
      idFromName: (name) => name,
      get: () => ({ publish: async (events) => (order.push('broadcast'), { delivered: events.length }) }),
    },
  };

  await flushOutboxes({
    php: { binary: Promise.resolve({ FS }) },
    env,
    onMail: async () => void order.push('mail'),
    onQueue: async () => void order.push('queue'),
    r2Binding: 'STORAGE',
    broadcastBinding: 'HUB',
  });

  assert.deepEqual(order, ['mail', 'queue', 'r2', 'broadcast']);
  assert.equal([...store.keys()].length, 0, 'every outbox file consumed');
});

test('missing handlers drop entries without throwing', async () => {
  const { FS } = fakeFs({
    '/tmp/outbox/m1.json': JSON.stringify({ mime: 'raw' }),
    '/tmp/broadcast-outbox/b1.json': JSON.stringify({ channels: [], event: 'e' }),
  });
  await flushOutboxes({ php: { binary: Promise.resolve({ FS }) }, env: {} });
});

test('drainDir unlinks even when an entry fails to parse', () => {
  const { FS, store } = fakeFs({ '/tmp/outbox/bad.json': 'not json' });
  assert.throws(() => drainDir({ FS }, '/tmp/outbox'));
  assert.equal(store.size, 0, 'the poison file is consumed, not retried forever');
});
