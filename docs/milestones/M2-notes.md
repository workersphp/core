# M2 Working Notes — Request Bridge + Modern PHP

## Empirical workerd findings (verified locally, wrangler 4.123.0, compat 2026-08-01)

- `typeof WebAssembly.Function` → `undefined` (no type reflection).
- `new WebAssembly.Module(bytes)` at request time → `CompileError: Wasm code generation
  disallowed by embedder` (confirmed; startup-phase-only, as research predicted).
- workerd global `addEventListener` rejects `useCapture: true` / options objects
  (`TypeError: addEventListener(): useCapture must be false`).
- No `location` global — Emscripten worker-target glue reads `self.location.href` at
  factory time; shimming `globalThis.location = new URL(...)` satisfies it.
- Emscripten `findWasmBinary()` eagerly evaluates `new URL(wasmFile, import.meta.url)`
  as a default argument even when `Module.locateFile` is provided → `Invalid URL string.`
  Local traces show `createWasm`'s catch swallows `instantiateWasm` hook errors and falls
  through to `findWasmBinary` — a misleading secondary error; always check the log for
  "Module.instantiateWasm callback failed" first.
- MAIN_MODULE glue: `receiveInstance(instance, module)` needs the compiled module as the
  second argument of the `receive` callback (dylink metadata parsing) — `receive(instance)`
  alone dies with `Cannot read properties of undefined (reading 'subarray')`.

## npm php-cgi-wasm@0.1.0 (PHP 8.4.1, MAIN_MODULE=2) status in workerd: NOT viable

Booted at global scope (startup-phase codegen allowed, top-level await) it serves ONE
request — PHP 8.4.1 runs, x-powered-by set, our CGI bridge works. But:

1. All extension constants except Core+date are missing (`get_defined_constants(true)`:
   'standard' count 0; ENT_QUOTES/PHP_URL_PATH/INFO_GENERAL undefined) while the same
   extensions' functions work. Session: "No storage module chosen".
2. Second `main()` in the same instance → `RuntimeError: null function` (broken wasm
   function-table entry), then any refresh at request time is blocked by the codegen ban.

Root cause class: the MAIN_MODULE=2 dynamic-linking machinery (dylink relocations,
JS→wasm adapter synthesis via tiny compiled-at-runtime modules, addFunction) collides
with workerd's no-runtime-codegen rule and no WebAssembly.Function. This is research
blocker #3 playing out exactly as predicted.

**Decision: fully-static build (MAIN_MODULE=0) pulled forward from M3.** Build system:
php-wasm repo Makefile via Docker (`seanmorris/php-emscripten-builder` image), driven by
`bin/php-wasm-builder.js build worker mjs cgi` with `build-php/.php-wasm-rc`:
`PHP_VERSION=8.4, MAIN_MODULE=0, WITH_SDL=0, WITH_LIBXML=0, WITH_NETWORKING=0`.
Base static extension set (bcmath, calendar, ctype, exif, filter, session, tokenizer +
core: pcre, json, hash, spl, standard, pdo, random, reflection, date) is sufficient for
the M2 demo; the Laravel set (mbstring, openssl, dom/xml, fileinfo, curl, pdo_sqlite)
is M3's static-linking work.

## What we built (keeps working regardless of binary)

`packages/runtime/src/PhpCgiWorkerd.mjs` — subclass of php-cgi-wasm's `PhpCgiBase`:
- workerd shims: `location` global, tolerant `addEventListener`.
- Synchronous `instantiateWasm` from a precompiled module, `receive(instance, module)`.
- Simplified `refresh()`: no IDBFS/persist, no navigator.locks, mkdir /preload /config
  /tmp + docroot, /php.ini (with `session.save_handler=files`, save_path /tmp).
- FIFO promise-chain mutex `_enqueue` — serializes requests + FS ops (one linear memory).
- Server-grade `request()`: per-request Cookie header (no shared jar), ALL request
  headers → HTTP_* env (with stale-key clearing between requests), CF-Connecting-IP →
  REMOTE_ADDR, Set-Cookie passthrough via getSetCookie, static file serving from MEMFS,
  CGI output parsing (Status/headers/body).
- `writeFiles(tree)` to populate MEMFS.

`examples/cgi/` — demo worker + multi-file PHP app (front controller, require'd lib,
sessions, cookie counter, POST form echo, header dump, static CSS), booted at global
scope with top-level await.
