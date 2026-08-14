# M1 Gate Results — Hello, PHP on workers.dev

**Date:** 2026-08-13 · **Status: PASSED**

Live at the time: a private workers.dev deployment (retired); reproduce with examples/hello (`/` and `/info`)

## What runs

PHP 8.2.11 (php-cloud reference binary, Emscripten 3.1.43, Asyncify) executing inside a plain
Cloudflare Worker isolate. A **fresh PHP interpreter instance is booted per request** (`pib_init`
→ `pib_run` via Asyncify ccall); wasm module imported as `CompiledWasm` and instantiated
synchronously in the Emscripten `instantiateWasm` hook.

Extensions: Core, date, pcre, bcmath, calendar, ctype, filter, hash, json, mbstring, SPL,
session, PDO, random, Reflection, standard, tokenizer, vrzno, zip.

## Measured numbers (production, workers.dev)

| Metric | Value | Notes |
|---|---|---|
| Bundle raw | 10,973 KiB | wasm 10.4 MiB + glue |
| Bundle gzip | **3,014 KiB** | fits paid limit (10 MB) with 7 MB headroom; ~58 KiB under even the free 3 MB cap |
| Deploy startup check | accepted, no error 10021 | global scope ≈ 0 ms active JS (per-request boot); wasm compile handled by platform within budget |
| CPU per request (fresh isolate, Liftoff) | **60–65 ms** | includes FULL interpreter boot + script execution |
| CPU per request (after tier-up) | **21–22 ms** | same full boot per request |
| CPU for phpinfo | 32 ms | |
| External latency, cold | 313 ms total | includes TLS + network from local machine |
| External latency, warm | 58–100 ms total | |
| Outcome | `ok` on all requests, exit code 0 | via `wrangler tail --format json` (`cpuTime`/`wallTime`) |

## Key learnings

1. **Per-request full interpreter boot costs only ~20–65 ms CPU.** Far cheaper than feared —
   an Octane-style persistent instance is an optimization, not a prerequisite, at least for
   plain PHP. (Laravel's 200–400-file bootstrap will change this arithmetic — measure at M4/M6.)
2. **Two glue patches were needed** to run the browser-targeted Emscripten build in workerd
   (both disappear once we do our own build in M3 with proper environment settings):
   - Removed the `typeof window=="object"||typeof importScripts=="function"` assertion
     ("not compiled for this environment") from the `ENVIRONMENT=web` branch.
   - Must pass `locateFile: (f) => f` in module args — its *presence* steers the glue away from
     `new URL("php-web.wasm", import.meta.url)`, which throws `Invalid URL string.` in workerd.
3. **Landmine for later: vrzno contains a direct `eval()`** (esbuild warns at deploy). `eval`
   is banned at request time in workerd — any PHP code path that triggers vrzno's JS-eval
   bridge will fail in production. Our M3 build should exclude or defang it (JS interop via
   registered callbacks instead of eval).
4. `wrangler check startup` must run from the example directory (fails on `-c` from repo root
   with a static-files detection error in wrangler 4.123.0).
5. `wrangler tail --format json` emits pretty-printed concatenated JSON (not JSONL), fields
   `cpuTime`/`wallTime`.

## Gate verdict

All three hard ceilings clear for the hello-world scale: size (3.0 MB gzip vs 10 MB), startup
(deploy accepted), memory (no OOM, single instance per request). Proceed to M2.
