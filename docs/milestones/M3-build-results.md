# M3 Results — Our Reproducible Static PHP 8.5 Build

**Date:** 2026-08-13 · **Status: COMPLETE — all Laravel demos now run on OUR binary**

## The binary

`packages/runtime/vendor/php-wasm-85-ours/` — PHP **8.5.2**, Emscripten web-mjs, embed SAPI,
`MAIN_MODULE=0` (fully static), built from seanmorris/php-wasm master via Docker
(`build-php/.php-wasm-rc`), then post-processed:

- 25 MB raw / **7.2 MB gzipped** wasm (bundle total 7.7 MB gz — fits the 10 MB paid cap)
- Memory section patched 128 MB → **48 MB** initial (wasm_mem.py 768) — the 128 MB default
  is baked in at link time and would make every isolate born at the memory ceiling
- Glue patched: `_posix_spawnp` abort → `return 52` (ENOSYS) so OPcache file_cache works

**Extensions (superset of the laravel-edge binary — adds the full XML family):**
bcmath, ctype, date, **dom, libxml, xml, SimpleXML, xmlreader, xmlwriter**, filter, hash,
json, lexbor, mbstring, openssl, pcre, PDO, pdo_cfd1, pdo_sqlite, session, sqlite3,
tokenizer, uri, vrzno, zip, zlib, Zend OPcache. (Still absent: curl, fileinfo, intl, gd —
known gaps, Laravel runs without them.)

Verified in production: php-laravel-fresh + php-laravel-do redeployed on this binary —
Blade, Livewire, sessions, welcome page all green.

## Build recipe (reproducible)

1. Clone seanmorris/php-wasm, `npm install` in it, apply
   laravel-edge's `patches/php-wasm-mbstring-static-build.patch` (upstream bug: configure
   silently drops mbstring), pre-clone `pdo-cfd1` into `third_party/`.
2. `build-php/.php-wasm-rc` = laravel-edge's proven env + `WITH_LIBXML/DOM/XML/SIMPLEXML/
   XMLREADER/XMLWRITER=static`. `MAIN_MODULE=0` is the non-negotiable line.
3. `node php-wasm/bin/php-wasm-builder.js build web mjs` from `build-php/` (Docker;
   amd64 image emulated on Apple Silicon works).
4. Post-process: wasm_mem.py 768 + posix_spawnp patch (see above), pair with the same
   checkout's `source/PhpBase.mjs`.

## Build-system traps hit (all now documented for repeat builds)

- macOS host lacks `wget` → curl-backed shim on PATH (Makefile downloads run on host).
- `third_party/pdo-cfd1/config.m4` has no make rule → pre-clone the repo.
- **The killer: `--cache-file=/src/.cache/config-cache`** — configure's autoconf cache
  lives OUTSIDE the source tree. An interrupted configure (e.g. Docker restart) poisons it
  with garbage (`sizeof(long)=0`, `HAVE_UNIX_H=1`), and every rebuild replays the lies even
  after deleting the whole PHP source tree. Symptoms: `Unknown SIZEOF_SIZE_T`,
  `unix.h file not found`, `(cached)` values in configure output. Fix: delete
  `.cache/config-cache` AND `third_party/php8.5-src`.
- Interrupted partial git clones in `third_party/` block re-clone rules (openssl).

## What this changes

The serving path is now 100% self-built: our packer → our runtime → our interpreter binary.
No third-party binary dependency anywhere. The build config is 40 lines in-repo, so adding
extensions (curl, fileinfo, intl) is a config change + rebuild, not an upstream request.
