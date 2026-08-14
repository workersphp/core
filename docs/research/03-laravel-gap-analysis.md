# Research: Laravel on PHP-in-WASM inside a Worker — Gap Analysis (Aug 2026)

## Requirements vs wasm builds

Laravel 12 needs PHP ≥ 8.2, Laravel 13 ≥ 8.3. Required extensions: **Ctype, cURL, DOM, Fileinfo, Filter, Hash, Mbstring, OpenSSL, PCRE, PDO, Session, Tokenizer, XML** — *all buildable*. WordPress Playground's `packages/php-wasm/compile/php/Dockerfile` has configure flags + prebuilt libs for every one (`WITH_OPENSSL`, `WITH_CURL`, `WITH_LIBXML` → dom/xml/simplexml/xmlreader/xmlwriter, `WITH_FILEINFO`, `WITH_MBSTRING`+oniguruma). PDO is conditional (`WITH_SQLITE`/`WITH_MYSQL`). OPcache buildable with `--disable-opcache-jit` + forced `php_cv_shm_mmap_anon=yes`. Universal caveats: `--without-pcre-jit`, `--disable-fiber-asm`, no JIT of any kind in wasm.

seanmorris builds: core set + runtime-loadable openssl/mbstring/libxml/dom/sqlite etc.; cURL **not** in documented list (riskiest gap there); Playground's is the reference build config for M3.

## Filesystem

Real measured Laravel projects (this machine): vendor 91–940 MB, 11k–37k files. Pruned `--no-dev` floor: **~25–45 MB, 8–12k files** (laravel+symfony alone = 3,473 files). App code itself trivial (~500 KB).

Playground: Emscripten **MEMFS** (`-s FORCE_FILESYSTEM=1 -s INITIAL_MEMORY=64MB -s ALLOW_MEMORY_GROWTH=1`), OPFS persistence in browser, NODEFS/PROXYFS in Node. seanmorris: IDBFS/NodeFS + preloaded assets.

**Read-only bundle + tiny writable overlay works for Laravel** if pre-baked:

| Laravel write | Mitigation |
|---|---|
| bootstrap/cache/*.php | `php artisan optimize` at build time |
| storage/framework/views | `php artisan view:cache` at build time |
| framework cache | driver → KV/D1 |
| sessions | driver → cookie/KV/D1 |
| logs | channel → stderr |
| storage/app uploads | disk → R2 |
| .env | Worker env vars (config-cached apps don't read .env at runtime) |

Delivery problem: bundle counts against 10 MB gz; **Static Assets don't, but are async-only** (`env.ASSETS.fetch`) vs PHP's sync `include` → preload into MEMFS on first request per isolate (memory cost!) or Asyncify every FS miss (~200–400 includes/request).

## Long-running mode

Octane servers (FrankenPHP/Swoole/RoadRunner) don't exist in wasm — we'd write a 4th SAPI shape: Playground exports `wasm_sapi_handle_request`/`wasm_sapi_request_shutdown`; FrankenPHP's `frankenphp_handle_request($handler)` loop + `gc_collect_cycles()` is the pattern. Documented Octane pitfalls that map to persistent isolates: singletons capturing container/request/config → cross-request leakage; unbounded static arrays; **no `--max-requests` restart lever on Workers**; `$_ENV` not reset. A per-tenant **Durable Object** is the only primitive that contains this by construction.

## Networking

Playground's bridges: fast path intercepts WP's HTTP client → `fetch()`; slow path is a **full TLS 1.2 stack in JS** (self-signed CA PHP is made to trust, MITM, re-issue as fetch) making `file_get_contents('https://…')`/curl work; Node uses WebSocket↔TCP proxy. Enabled by Asyncify with a hand-maintained `ASYNCIFY_ONLY` list (`wasm_connect`, `wasm_recv`, `wasm_poll_socket`, `curl_easy_perform`, `php_mysqlnd_net_open_tcp_or_unix_pub`, …) — "missing even a single item… results in a WebAssembly crash." mysqlnd is already patched for wasm (`apply-mysqlnd-patch.sh`) → could back with `connect()`/Hyperdrive later. CORS pain is browser-only — Workers `fetch()` has none.

For us: **never let PHP open a socket.** D1 via `pdo_cfd1` (positional params only — fine: Laravel's query builder emits positional `?` bindings); HTTP via Guzzle handler → JS `fetch()` bridge.

## Performance expectations

- Wasm tax: ~1.45–2.5× slower than native (USENIX ATC '19; 2026 runtime benchmarks similar).
- Wasmer: WP page 620 ms → **205 ms with OPcache-in-wasm (3×)**; ~3–7× native PHP-FPM.
- Playground: fresh WP boot 5–10 s in-browser; Asyncify overhead "substantial"; JSPI removes it (V8-only — fine for workerd, test in M3).
- Python Workers: 10 s → 1 s via memory snapshots.
- **Nobody has published a Laravel cold-boot number in php-wasm** — we'll be first. Laravel loads 200–400 files/request; parse/compile is 50–75% of request time without OPcache → expect high-hundreds-ms to low-seconds cold, far better warm.
- *(M1 empirical: full interpreter boot + tiny script = 21–65 ms CPU in production.)*

## What Playground actually patches in PHP (small!)

`php8.4.patch` is 39 lines: `unistd.h` include for `getpid`; zero-byte `copy()` crash guard. Plus: mysqlnd patch, `proc_open.c` → `js_open_process`, custom `php_wasm.c` SAPI, `-Dsetsockopt=wasm_setsockopt -Dphp_exec=wasm_php_exec`, `--enable-wasm_memory_storage --enable-dns_polyfill --enable-post_message_to_js`. **Process functions are dead everywhere**: `exec`/`system`/`proc_open` no-op → no `queue:work`, no `schedule:run`, no `Process::run()` → Cloudflare Queues / Cron Triggers / build-time artisan.

## OpenSSL / crypto

OpenSSL compiles in (both ecosystems; prebuilt libs for Asyncify and JSPI variants) → Encrypter/APP_KEY/encrypted cookies/signed URLs fine. `random_bytes` → `getentropy` → `crypto.getRandomValues` (exists in Workers). **Snapshot hazard:** snapshotting a booted heap freezes RNG state (hash seeds, mt_rand) — reseed after restore (Python Workers' poison-seed pattern). ext/openssl ≠ TLS transport: no real sockets, so outbound HTTPS goes through the JS bridge, not libssl.

## Top 5 blockers, ranked

1. **128 MB memory**: interpreter linear memory (64 MB initial + growth) + MEMFS vendor tree (25–45 MB) + booted-Laravel working set (40–80 MB native-equiv) + JS heap. Playground issue #1278: `mmap` in-place resize doesn't exist in wasm → growth holds old+new regions. Stress-test first (M4 gate).
2. **~10k vendor files into a sync FS**: interpreter is already 20 MB raw / 7.6 MB gz (76% of the paid compressed budget) → app must ship as Static Assets; preload-vs-lazy trade.
3. **No runtime wasm codegen**: kills Playground's `dlopen` side-module architecture as-is → bespoke fully-static single-module build with every needed extension linked in.
4. **Asyncify fragility** (allowlist) → mitigate by no-sockets design; JSPI as structural fix.
5. **Cold boot × eviction, no platform snapshot API** → userland snapshot (M7); warm path inherits Octane leakage hazards with no restart lever.

## Recommended shape (adopted in plan)

Fully-static PHP 8.3/8.4, JSPI-if-it-works, Laravel extension set, no intl/gd/zip/soap; bake at build (`--no-dev`, prune, `artisan optimize`); no writable app FS (KV/D1/R2/stderr drivers); D1 via pdo_cfd1; Guzzle→fetch; DO for boot-once semantics; Containers as the priced escape hatch.

Key sources: [Laravel 12 deployment docs](https://laravel.com/docs/12.x/deployment) · [Playground Dockerfile](https://raw.githubusercontent.com/WordPress/wordpress-playground/trunk/packages/php-wasm/compile/php/Dockerfile) · [php8.4.patch](https://raw.githubusercontent.com/WordPress/wordpress-playground/trunk/packages/php-wasm/compile/php/php8.4.patch) · [Asyncify](https://wordpress.github.io/wordpress-playground/developers/architecture/wasm-asyncify) · [FS](https://wordpress.github.io/wordpress-playground/developers/architecture/wasm-php-filesystem) · [issue #1278](https://github.com/WordPress/wordpress-playground/issues/1278) · [issue #710](https://github.com/WordPress/wordpress-playground/issues/710) · [Octane docs](https://laravel.com/docs/12.x/octane) · [FrankenPHP worker mode](https://frankenphp.dev/docs/worker/) · [Liminal](https://laravel-news.com/liminal) · [pdo-cfd1](https://github.com/seanmorris/pdo-cfd1) · [Not So Fast (ATC'19)](https://www.usenix.org/conference/atc19/presentation/jangda)
