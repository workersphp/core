# Research: PHP → WebAssembly & PHP on Cloudflare Workers — Prior Art (Aug 2026)

**Headline: PHP has publicly shipped on Cloudflare Workers, twice, by two independent parties; both artifacts were live and verified by HTTP during this research.** The 2023 consensus that "PHP can't fit in a Worker isolate" is obsolete.

## 1. seanmorris/php-wasm — the living upstream

- https://github.com/seanmorris/php-wasm · docs https://php-wasm.seanmorr.is/ — last push the day of research; 1.4k stars; npm `php-wasm@0.1.0` (first stable).
- PHP 8.0–8.5 (default 8.4). Emscripten (lineage oraoto/pib → seanmorris). Packages: `php-wasm`, `php-cgi-wasm`, `php-cli-wasm`, `php-dbg-wasm`, **`php-wasm-builder`** (Docker CLI, `.php-wasm-rc` config).
- Runtime-loadable extensions: gd, iconv, intl, libxml, xml, dom, simplexml, yaml, zip, mbstring, openssl, phar, sqlite, zlib. Extras: **Vrzno** (JS↔PHP bridge), **pdo_cfd1** (Cloudflare D1), **pdo_pglite** (Postgres).
- **pdo-cfd1** (https://github.com/seanmorris/pdo-cfd1): pass D1 binding as `cfd1: { mainDb: env.mainDb }` → `new PDO('cfd1:mainDb')`. PHP ≥ 8.1. Gaps: positional `?` params only; rudimentary error handling.

## 2. seanmorris/php-cloud — the shipped Cloudflare deployment

https://github.com/seanmorris/php-cloud · live at https://php-cloud.pages.dev (verified: `/hello-php` 200 with 54 KB phpinfo; `/wiki.php` D1-backed wiki; PHP 8.2.11, Emscripten 3.1.43, Nov 2023 build).

Sizes (GitHub API): `php-web.wasm` 10,945,578 B raw / 3,001,767 gz / **2,320,507 br (2.21 MiB — under even the free 3 MB cap)**; glue 187 KiB.

Build (`.php-wasm-rc`): `OPTIMIZE=z`, no libxml/tidy/iconv/ICU/sqlite, WITH_LIBZIP=1, WITH_VRZNO=1. Configure: `--enable-embed=static --disable-fiber-asm --disable-all --enable-session --enable-filter --enable-calendar --without-pcre-jit --enable-bcmath --enable-json --enable-ctype --enable-mbstring --disable-mbregex --enable-tokenizer --with-gd --with-zip --enable-vrzno`.

Architecture (Pages Function): `import WasmBinary from '../php-web.wasm'` → synchronous `new WebAssembly.Instance(WasmBinary, info)` in `instantiateWasm` (mandatory Workers pattern); Asyncify ccall (`pib_run`, `{async:true}`); output streamed via TransformStream + `waitUntil`; **no bundled FS** — PHP source fetched per request from an external static origin; D1 via `context.env.db`.

Status: working PoC, unmaintained since 2024-10, ~4 stars, essentially undiscovered.

## 3. WordPress Playground (@php-wasm/*)

- https://github.com/WordPress/wordpress-playground — deepest PHP-in-wasm engineering. Emscripten, custom `php_wasm.c` SAPI, two async modes: **Asyncify** and **JSPI**, built `MAIN_MODULE=2`. PHP 7.4–8.5.
- Asyncify = save whole C stack → yield to JS → resume. Hand-maintained function allowlist; "missing even a single item results in a WebAssembly crash."
- Package split (Jan 2026): per-version packages (`@php-wasm/web-8-5` etc.), ~63 MB each vs 530 MB classic. Size work (Mar 2026): MAIN_MODULE=1→2 tree-shaking; per-version wasm: 7.4≈17 MB … 8.5≈24 MB.
- **Issue #69** ("Run on Cloudflare Workers", opened 2022, still open/Blocked): 2023 verdicts — 4.4 MB stripped build under then-5 MB limit but **"Loading PHP alone exceeds CloudFlare 128MB memory limit"** (`Script startup exceeded memory limits. [code: 10021]`). 2025: blocked again on 25 MiB static-asset cap for latest.zip.
- **PR #4111 (Jul 2026, @chubes4) — the breakthrough**: live Worker (verified) boots **PHP 8.5.8 Asyncify, 21,019,221-byte wasm, inside a deployed isolate** — refutes the 2023 memory verdict. Wrangler: `compatibility_date 2025-10-01`, `nodejs_compat`, `rules: [{type:"CompiledWasm", globs:["**/*.wasm"], fallthrough:false}]`. Streams WordPress from wordpress.org/latest.zip via HTTP **Range requests** (answer to the 25 MiB asset cap). Requires paid plan. Notes Cloudflare freezes `performance.now()`/`Date.now()` during execution — measure via `wrangler tail` only. Scope excludes WordPress itself, SQLite, persistence.

## 4. Dead ends & adjacent

| Project | Verdict |
|---|---|
| VMware Wasm Labs php-wasm (WASI) | **Abandoned** (archival notice; last PHP release 8.2.6, Jul 2023). WASI preview1 not native in workerd. Fermyon Spin's PHP wraps this dead build; Fermyon acquired by Akamai. |
| Wasmer PHP (WASIX) | Active & impressive — **OPcache statically linked into wasm: WordPress render ~620→~205 ms (3×)**; wasm-exceptions instead of Asyncify; claims WP/Laravel/Symfony unmodified. **Needs threads/sockets/fork — impossible in workerd.** Ideas transferable, binaries not. |
| oraoto/pib | 2020 ancestor of the whole Emscripten line. Historical. |
| makalin/php2wasm | Claims Workers/WASI targeting; alpha, ~3 commits, no artifacts. Speculation. |
| cloudflare/php-worker-hello-world | PHP→JS transpile (babel-preset-php), ancient toy, not wasm. |
| Cloudflare EmDash (blog 2026-04) | Cloudflare's own answer to WordPress: a **TypeScript rewrite** — i.e. no first-party PHP runtime is coming. |

## 5. Laravel under php-wasm

- **Play with Laravel** (https://playwithlaravel.com, github ijpatricio/playwithlaravel): full `laravel new` + Breeze Livewire/Volt entirely in-browser on php-wasm.
- seanmorris official demos include **Laravel 11** (+ Drupal 7, CakePHP 5, CodeIgniter 4, Laminas 3).
- **Nobody has run Laravel in a Cloudflare Worker.**

## Verdict

Solved by prior art: bundle size, 128 MB fit, precompiled-wasm instantiation, Asyncify-in-workerd, D1-via-PDO. Genuinely unsolved: **the filesystem** (no one bundles one — both artifacts fetch source remotely), cold-instantiation cost of 10–21 MB modules, the extension/size trade-off, OPcache in an Emscripten build, Asyncify fragility (JSPI is the better path). No library, no framework adapter, no published package exists — the most valuable unclaimed work is the FS layer + size-tuned build matrix + OPcache.

Key links: [php-wasm](https://github.com/seanmorris/php-wasm) · [php-cloud](https://github.com/seanmorris/php-cloud) · [pdo-cfd1](https://github.com/seanmorris/pdo-cfd1) · [Playground issue #69](https://github.com/WordPress/wordpress-playground/issues/69) · [PR #4111](https://github.com/WordPress/wordpress-playground/pull/4111) · [Asyncify docs](https://wordpress.github.io/wordpress-playground/developers/architecture/wasm-asyncify/) · [package split](https://make.wordpress.org/playground/2026/01/08/a-lighter-more-modular-wordpress-playground-understanding-the-php-wasm-package-split/) · [size cut](https://make.wordpress.org/playground/2026/03/11/how-wordpress-playground-cut-php-wasm-binary-sizes-by-122-mb/) · [Wasmer PHP edge](https://wasmer.io/posts/running-php-blazingly-fast-at-the-edge-with-wasm) · [EmDash](https://blog.cloudflare.com/emdash-wordpress/)
