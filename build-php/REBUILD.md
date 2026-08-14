# Rebuilding the PHP binaries from scratch

Both binaries build from a `seanmorris/php-wasm` checkout via Docker. The checkout
itself is disposable; everything needed to reproduce lives in this repo.

## Setup (once per checkout)

```sh
git clone https://github.com/seanmorris/php-wasm /tmp/php-wasm && cd /tmp/php-wasm
npm install                                  # workspace deps the Makefile needs
git clone --depth 1 https://github.com/seanmorris/pdo-cfd1.git third_party/pdo-cfd1
git apply /path/to/php-v8/build-php/patches/*.patch
# patches: pdo-cfd1 lastInsertId (C fix), posix_spawnp ENOSYS stub (pib.c),
#          mbstring static-build configure fix, ASYNCIFY_EXPORTS Makefile hook,
#          WASM_EH_FLAGS Makefile hook (wasm-exceptions for the JSPI variant)
docker compose --progress quiet pull         # emscripten-builder image (amd64; emulates fine on Apple Silicon)
```

macOS host also needs a `wget` shim on PATH (Makefile downloads run on the host):

```sh
mkdir -p ~/bin && printf '#!/bin/bash\nout=""; url=""\nwhile [ $# -gt 0 ]; do case "$1" in -O) out="$2"; shift 2;; -*) shift;; *) url="$1"; shift;; esac; done\n[ -z "$out" ] && out="$(basename "$url")"\nexec curl -fsSL --retry 5 -o "$out" "$url"\n' > ~/bin/wget && chmod +x ~/bin/wget
```

## Build

```sh
# Asyncify build (current production binary):
cd php-v8/build-php      && PATH=~/bin:$PATH node /tmp/php-wasm/bin/php-wasm-builder.js build web mjs
# JSPI variant:
cd php-v8/build-php-jspi && PATH=~/bin:$PATH node /tmp/php-wasm/bin/php-wasm-builder.js build web mjs
```

Artifacts land next to each `.php-wasm-rc`. Vendor by copying `php8.5-web.mjs` +
`php8.5-web.mjs.wasm` into `packages/runtime/vendor/php-wasm-85-{ours,jspi}/`
(support .mjs files there come from the same checkout's `source/` and rarely change).
No post-build patching: memory (INITIAL_MEMORY=48MB) and all fixes are build inputs.

Note: `build-php-jspi/.php-wasm-rc` points `CFBINDINGS_DEV_PATH` at
`../build-php/ext-cfbindings`, resolved from the rc's own directory (builds
run with `cd build-php-jspi`). If your builder version resolves it elsewhere,
set an absolute path to `<this-repo>/build-php/ext-cfbindings`.

## Known traps

- **Interrupted configure poisons the SHARED autoconf cache** at `<checkout>/.cache/config-cache`
  (it lives OUTSIDE the source tree). Symptoms: `Unknown SIZEOF_SIZE_T`, `unix.h not found`,
  `(cached) 0` values in configure output. Fix: delete `.cache/config-cache` AND
  `third_party/php8.5-src`, rebuild.
- Partial git clones in `third_party/` block re-clone rules — delete the dir.
- Changing configure-affecting flags: delete the `configured` stamp in the PHP source dir.
- `OPTIMIZE=z` wasm-opt runs silently for tens of minutes; that's normal.

## JSPI status (build-php-jspi)

Links clean (17MB vs 25MB, -32%) with `ASYNCIFY=2` + `ASYNCIFY_EXPORTS_FLAG`
(pib_* entrypoints wrapped). Plain-Asyncify objects hit a runtime wall: Zend's
setjmp/longjmp used Emscripten JS `invoke_*` trampolines and JSPI cannot suspend
across JS frames (`SuspendError: trying to suspend JS frames`). The fix is native
wasm exceptions — `WASM_EH_FLAGS=-sSUPPORT_LONGJMP=wasm -fwasm-exceptions` in
`.php-wasm-rc` (threaded through PHP's EXTRA_CFLAGS/EXTRA_CXXFLAGS and the link
by the `php-wasm-wasm-eh.patch` Makefile hook). Same flag combination WordPress
Playground ships for its JSPI builds
(https://github.com/WordPress/wordpress-playground/blob/trunk/packages/php-wasm/compile/php/Dockerfile).
These are compile-time flags: object code changes, so a clean `third_party/php8.5-src`
recompile is required (delete the dir; the shared `.cache/config-cache` can stay —
EXTRA_CFLAGS never reaches configure). Static dep archives (oniguruma, openssl,
zlib, libzip, sqlite, libxml2) contain no setjmp users and relink unchanged; after
a build, verify no `invoke_` trampolines remain in the glue
(`grep -c 'invoke_' php8.5-web.mjs` should be 0) before vendoring.
Motivation: V8-generated code for the wasm module counts against the 128MB isolate;
the 17MB module is the projected closer for the starter-kit dashboard gate.
