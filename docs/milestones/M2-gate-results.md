# M2 Gate Results — Request Bridge + Modern PHP on workers.dev

**Date:** 2026-08-13 · **Status: PASSED**

Live at the time: a private workers.dev deployment (retired)

## What runs

**PHP 8.5.2** (fully-static MAIN_MODULE=0 build, embed SAPI, from togishima/laravel-edge's
release binary) resident per isolate, serving a multi-file PHP app from MEMFS through our
`PhpEmbedWorkerd` runtime (`packages/runtime/src/PhpEmbedWorkerd.mjs`):

- Generic PHP dispatcher per request: full `$_SERVER` (all headers → HTTP_*), `$_GET`,
  `$_POST` (urlencoded), `$_COOKIE`, raw body; front-controller require; output + `headers_list()`
  + `http_response_code()` captured into a base64 sentinel envelope on stdout.
- `pib_refresh` between requests (php_embed_shutdown/init) — request state reset, MEMFS persists.
- FIFO promise-chain mutex serializes requests (one linear memory).
- Static files served from MEMFS by the JS layer.
- Extensions: Core, date, openssl, pcre, sqlite3, zlib, bcmath, ctype, filter, hash, json,
  lexbor, **mbstring**, **Zend OPcache**, uri, SPL, PDO, **pdo_cfd1**, pdo_sqlite, pib, random,
  Reflection, **session**, tokenizer, standard, vrzno, zip.

## Verified (local + production)

| Surface | Result |
|---|---|
| Sessions (PHPSESSID, /tmp MEMFS) | ✅ increments across requests within an isolate (local 2→3→4) |
| Cookies (setcookie + round trip) | ✅ visits counter increments |
| POST form → `$_POST` | ✅ echoed back (prod verified) |
| Request headers → `$_SERVER[HTTP_*]` | ✅ custom header probe |
| Query string → `$_GET` | ✅ |
| Static file with content-type | ✅ text/css |
| Status/headers/Set-Cookie passthrough | ✅ (session no-cache headers, multiple Set-Cookie) |
| Constants (ENT_QUOTES etc.) | ✅ all present (static build) |

## Production numbers

| Metric | Value |
|---|---|
| Bundle | 23,868 KiB raw / **6,587 KiB gzip** (fits 10 MB paid) |
| Wasm | 22.5 MB raw, INITIAL_MEMORY patched to 48 MB (768 pages) |
| CPU per request | **141–218 ms** (OPTIMIZE=z build, refresh+dispatcher per request, no opcache tuning yet) |
| External latency | ~0.45–0.6 s total from local machine |
| Isolate reuse | ✅ confirmed (x-php-request-count 2→3); multiple isolates load-balanced |

Caveat surfaced (expected): **MEMFS sessions don't span isolates** — production shows
session hits=1 when requests land on different isolates. This is the platform reality the
plan already accounts for: Laravel sessions go to cookie/D1 drivers (M5).

## The two big discoveries of M2

1. **npm php-cgi-wasm cannot work on Workers** — all published binaries are MAIN_MODULE
   dynamic builds; workerd forbids runtime wasm codegen (verified: no `WebAssembly.Function`,
   `CompileError` on request-time compile). Root cause chain fully documented in
   docs/M2-notes.md (constants dying at libxml's dlopen in MINIT, null-function on second
   main, `data:` URL rejection).
2. **togishima/laravel-edge exists** (days old): the first shipped Laravel-13-on-Workers,
   embed SAPI + static build + D1 + OPcache. Its war-stories doc validated/updated our plan;
   its prebuilt static PHP 8.5.2 binary is now vendored at
   `packages/runtime/vendor/php-wasm-85/` and powers this milestone. Their critical tricks
   adopted: `return receive(instance)` in instantiateWasm (Asyncify hangs otherwise), shims
   (setImmediate!), direct `pib_run` ccall with `{async:true}`, INITIAL_MEMORY 48 MB,
   posix_spawnp → ENOSYS glue patch, no-Artisan warmup.

## Next

- M3 (running): our reproducible build — laravel-edge config + libxml/dom/xml static.
- M4: app packer + Static Assets zip delivery (laravel-edge proved the pattern with ZipArchive).
- M5: D1 via pdo_cfd1 (driver already in the binary), cookie sessions, KV cache.
- M6: Laravel boots (laravel-edge proves it's possible — ours is about making it a runtime, not a one-off).
