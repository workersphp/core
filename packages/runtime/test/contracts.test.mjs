import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encoder, decoder, toBase64, fromBase64, extractEnvelope, metaToPhp,
} from '../src/contracts.mjs';
import { serveStatic, isPrivateBundlePath } from '../src/static.mjs';

test('base64 round-trip survives the 0x8000 chunk boundary', () => {
  const bytes = new Uint8Array(0x8000 * 2 + 17).map((_, i) => i % 251);
  assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
});

test('extractEnvelope finds the envelope inside interleaved stdout', () => {
  const envelope = { status: 200, headers: { 'X-Test': ['1'] }, body: toBase64(encoder.encode('hi')) };
  const wire = `warmup noise\n@@ENV@@${toBase64(encoder.encode(JSON.stringify(envelope)))}@@/ENV@@\ntrailing`;
  assert.deepEqual(extractEnvelope(wire), envelope);
  assert.equal(extractEnvelope('no envelope here'), null);
});

test('metaToPhp is base64 of the JSON payload', () => {
  const meta = { method: 'GET', uri: '/x?y=1', secrets: { 'app.key': 'k' } };
  assert.deepEqual(JSON.parse(decoder.decode(fromBase64(metaToPhp(meta)))), meta);
});

test('the bundle privacy guard catches every zip spelling', () => {
  for (const path of ['/app.zip', '/app%2Ezip', '/APP.ZIP', '/a/b/App.Zip', '/x%2ezip']) {
    assert.equal(isPrivateBundlePath(path), true, path);
  }
  for (const path of ['/build/app.css', '/zip.html', '/app.zip.txt', '/']) {
    assert.equal(isPrivateBundlePath(path), false, path);
  }
  // Malformed escapes stay encoded and are judged as-is.
  assert.equal(isPrivateBundlePath('/broken%zz.zip'), true);
  assert.equal(isPrivateBundlePath('/broken%zz.css'), false);
});

test('serveStatic serves only real dotted non-php files under the docroot', () => {
  const files = { '/app/public/style.css': new Uint8Array([99]) };
  const module = {
    FS: {
      analyzePath: (p) => ({ exists: p in files, object: { mode: 0o100644 } }),
      isFile: () => true,
      readFile: (p) => files[p],
    },
  };
  assert.equal(serveStatic(module, '/no-extension', '/app/public'), null);
  assert.equal(serveStatic(module, '/index.php', '/app/public'), null);
  assert.equal(serveStatic(module, '/missing.css', '/app/public'), null);
  const res = serveStatic(module, '/style.css', '/app/public');
  assert.equal(res.headers.get('content-type'), 'text/css');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
});
