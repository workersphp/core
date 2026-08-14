// JSPI smoke: the production wasm pairing boots under Node and survives the
// four historical failure modes (plain echo, uncaught exception, fatal
// bailout, usleep suspension).
//
// Run with:  node --experimental-wasm-jspi --test packages/runtime/test/
//
// The pairing mirrors what wrangler bundles for prod: loader + wasm from the
// -jspi vendor dir, PhpBase from -ours (LaravelWorkerd.mjs's own import).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtime = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (typeof WebAssembly.Suspending !== 'function') {
  throw new Error('JSPI unavailable: run under Node 24+ with --experimental-wasm-jspi');
}

const { PhpBase } = await import(join(runtime, 'src/phpbase/PhpBase.mjs'));
const { default: loader } = await import('@workersphp/php-wasm-jspi/php8.5-web.mjs');
await import(join(runtime, 'src/shims.mjs'));

const wasmModule = await WebAssembly.compile(
  readFileSync(new URL(import.meta.resolve('@workersphp/php-wasm-jspi/php8.5-web.mjs.wasm'))),
);

const php = new PhpBase(Promise.resolve(loader), {
  ini: 'date.timezone=UTC',
  locateFile: (file) => file,
  instantiateWasm(info, receive) {
    const instance = new WebAssembly.Instance(wasmModule, info);
    return receive(instance);
  },
});
const module = await php.binary;

async function run(code) {
  let out = '';
  let err = '';
  const onOut = (e) => (out += e.detail);
  const onErr = (e) => (err += e.detail);
  php.addEventListener('output', onOut);
  php.addEventListener('error', onErr);
  let exitCode;
  try {
    exitCode = await module.ccall('pib_run', 'number', ['string'], ['?>' + code], { async: true });
  } finally {
    php.flush();
    php.removeEventListener('output', onOut);
    php.removeEventListener('error', onErr);
  }
  return { out, err, exitCode };
}

test('echo round-trip', async () => {
  const { out } = await run('<?php echo "hello-" . (40 + 2);');
  assert.match(out, /hello-42/);
});

test('uncaught exception is reported and the interpreter recovers', async () => {
  const { out, err } = await run('<?php throw new RuntimeException("smoke-boom");');
  assert.match(out + err, /smoke-boom/);
  const next = await run('<?php echo "alive-after-exception";');
  assert.match(next.out, /alive-after-exception/);
});

test('fatal error bails out without killing the module', async () => {
  const { out, err, exitCode } = await run('<?php this_function_does_not_exist();');
  assert.ok(exitCode !== 0 || /Error/.test(out + err), 'fatal surfaced');
  const next = await run('<?php echo "alive-after-fatal";');
  assert.match(next.out, /alive-after-fatal/);
});

test('usleep suspends and returns under JSPI', async () => {
  const started = performance.now();
  const { out } = await run('<?php usleep(20000); echo "slept";');
  assert.match(out, /slept/);
  // Guard against the historical busy-wait hang: this must complete promptly,
  // not spin until a watchdog kills it.
  assert.ok(performance.now() - started < 5000, 'usleep returned promptly');
});
