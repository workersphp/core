// The production trap this guards: workerd freezes Date.now/performance.now
// during CPU execution, PHP 8.5's uniqid() polls gettimeofday until the
// microsecond CHANGES, so without the clock nudge every uniqid() after the
// first spins forever. Local clocks advance, hiding it — this test freezes
// them explicitly around a real wasm run.
//
// Run with:  node --experimental-wasm-jspi --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPhp, runPhp, nudgeClocks } from '../src/php.mjs';

const runtime = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (typeof WebAssembly.Suspending !== 'function') {
  throw new Error('JSPI unavailable: run under Node 24+ with --experimental-wasm-jspi');
}

test('nudgeClocks keeps a frozen clock monotonically creeping', () => {
  const frozen = () => 1000;
  const info = { env: { emscripten_get_now: frozen, emscripten_date_now: frozen } };
  nudgeClocks(info);
  const a = info.env.emscripten_get_now();
  const b = info.env.emscripten_get_now();
  const c = info.env.emscripten_date_now();
  assert.ok(b > a, 'frozen reads still advance');
  assert.ok(c >= 1000, 'starts from real time');
});

test('nudgeClocks re-syncs when real time advances', () => {
  let now = 1000;
  const info = { env: { emscripten_get_now: () => now, emscripten_date_now: () => now } };
  nudgeClocks(info);
  info.env.emscripten_get_now();
  now = 5000;
  assert.equal(info.env.emscripten_get_now(), 5000);
});

test('uniqid() x4 under a frozen clock: distinct values, no hang', async () => {
  const { PhpBase } = await import(join(runtime, 'src/phpbase/PhpBase.mjs'));
  const { default: loader } = await import('@workersphp/php-wasm-jspi/php8.5-web.mjs');
  await import(join(runtime, 'src/shims.mjs'));
  const wasm = await WebAssembly.compile(
    readFileSync(new URL(import.meta.resolve('@workersphp/php-wasm-jspi/php8.5-web.mjs.wasm'))),
  );

  // Freeze the JS clocks BEFORE boot so emscripten's imports capture frozen
  // sources, exactly like workerd's CPU-time freeze. performance.now is what
  // emscripten_get_now reads; Date.now feeds emscripten_date_now.
  const realDateNow = Date.now;
  const realPerfNow = performance.now.bind(performance);
  const frozenAt = realDateNow();
  const frozenPerf = realPerfNow();

  const php = createPhp({ PhpBaseClass: PhpBase, loader, wasm, ini: 'date.timezone=UTC' });
  let out = '';
  const collect = (e) => (out += e.detail);
  php.addEventListener('output', collect);
  php.addEventListener('error', collect);
  await php.binary;

  Date.now = () => frozenAt;
  performance.now = () => frozenPerf;
  try {
    const started = realPerfNow();
    await runPhp(php, `<?php
      $ids = [uniqid(), uniqid(), uniqid(), uniqid()];
      usleep(1000);
      echo 'IDS:' . implode(',', $ids) . ':' . count(array_unique($ids)) . ':done';
    `);
    const elapsed = realPerfNow() - started;
    assert.ok(elapsed < 10000, `completed promptly under frozen clocks (${elapsed}ms)`);
  } finally {
    Date.now = realDateNow;
    performance.now = realPerfNow;
    php.removeEventListener('output', collect);
    php.removeEventListener('error', collect);
  }

  const match = out.match(/IDS:([^:]+):(\d+):done/);
  assert.ok(match, `script completed (got: ${out.slice(0, 200)})`);
  assert.equal(match[2], '4', `all four uniqid() values distinct: ${match[1]}`);
});
