# Research: Cloudflare Workers Constraints for a Large-WASM PHP Runtime (verified Aug 2026)

All numbers pulled live from developers.cloudflare.com, the changelog, or `cloudflare/workerd` source. Notable changes vs common memory: startup is **1 s** (not 400 ms); there's a **64 MB uncompressed** ceiling; subrequests overhauled Feb 2026.

## Size

| Limit | Free | Paid |
|---|---|---|
| Worker bundle (gzipped) | 3 MB | **10 MB** |
| Worker bundle (uncompressed) | 64 MB | 64 MB |
| Individual static asset | 25 MiB | 25 MiB |
| Static asset files/version | 20,000 | **100,000** |

Wasm counts toward bundle size. Wasm gzips ~2.5–3.5×, so 12–15 MB php.wasm ≈ 4–5 MB gz. Check via `wrangler deploy --dry-run --outdir`.

## Dynamic wasm — the hard "no", with one exception

- `WebAssembly.instantiate()` from bytes → `CompileError: Wasm code generation disallowed by embedder`. Only precompiled module imports work at request time.
- workerd source: wasm codegen tied to eval permission (`setup.c++: allowWasmCallback` returns `evalAllowed`).
- **Exception:** `allow_eval_during_startup` flag (default on since compat date **2025-06-01**) → `WebAssembly.compile(bytes)` works in **global scope only** (`worker.c++: setAllowEval(js, …getAllowEvalDuringStartup()); KJ_DEFER(setAllowEval(false))`).
- But **async I/O is banned in global scope**, so you cannot fetch wasm from R2/KV/assets at startup. Net: wasm must ship in the bundle; startup-eval only buys transforming bundled bytes (e.g. brotli-unpack then compile).
- Worker Loaders (Dynamic Workers) module types: js/cjs/py/text/data/json — **no wasm**.
- `WebAssembly.instantiate(module, imports)` against a precompiled module is legal at request time.

## Memory

**128 MB per isolate** — "including the JavaScript heap and WebAssembly allocations… per-isolate, not per-invocation. A single isolate can handle many concurrent requests." On exceed: in-flight requests complete, new isolate for subsequent requests. `FinalizationRegistry` behind `enable_weak_ref` explicitly recommended for wasm Workers hitting `Exceeded Memory` (frees Emscripten heap allocations). Memory metrics in dashboard since 2026-06 (P50–P999).

## CPU / startup / wall clock

| Limit | Free | Paid |
|---|---|---|
| **Startup (global scope parse+execute)** | 1 s | 1 s |
| CPU per HTTP request | 10 ms | 30 s default, `limits.cpu_ms` up to **300,000** |
| Wall clock (HTTP) | unlimited while client connected; `waitUntil` +30 s | same |

Failure: `Script startup exceeded CPU time limit` (code 10021). I/O wait doesn't count toward CPU.

**Wasm compile story (the crux):** compilation happens **per isolate** inside the startup budget (`worker-modules.h: compileWasmGlobal` — uses AllowEvalScope + V8 background-thread tier-up: **Liftoff baseline first, TurboFan later**; early requests run Liftoff-quality code). No first-party deploy-time compile cache for user Workers. There's a separate `enterStartupPython()` budget for Cloudflare's own Python runtime — user Workers don't get it.

## WASI: dead

`@cloudflare/workers-wasi` last release 0.0.5 (Feb 2022). `fd_readdir`, `path_*link`, `poll_oneoff`, `sock_*` all `ENOSYS`. No threads anywhere in Workers (`SetAllowAtomicsWait(false)`, no SharedArrayBuffer; build with `-sUSE_PTHREADS=0`). SIMD supported. → Emscripten, not WASI.

## Isolate lifetime

Global scope executes once, isolate serves many **concurrent** requests; may be evicted anytime; "do not use or mutate global state" is advisory; I/O objects can't cross requests (`Cannot perform I/O on behalf of a different request`). **PHP trap:** one wasm linear memory + concurrent requests = corruption at any `await` → serialize via promise-chain mutex, per-request instances, or snapshot-restore.

## I/O available

| Capability | Notes |
|---|---|
| `connect()` (cloudflare:sockets) | GA; MySQL/Postgres/Mongo wire protocols explicitly OK; `starttls`; not in global scope; port 25 blocked; no inbound TCP |
| Hyperdrive | Postgres GA; **MySQL GA 2026-08-07**; 60 s query max; pooling |
| D1 | 10 GB paid; ≤100 bound params/stmt; ≤100 cols; row ≤2 MB; 30 s/query |
| KV | 25 MiB value; **1 write/s per key**; 1,000 ops/invocation |
| Cache API | ≤512 MB object; 50/req free, 1,000 paid |
| **Static Assets** | **`env.ASSETS.fetch(request)` readable at runtime** (hostname ignored, only pathname matters); the key architectural fact — app tree ships as assets, outside the bundle |
| Durable Objects | per-DO SQLite; pinned addressable isolate; TCP socket keeps DO billable ≤15 min |
| Subrequests | Feb 2026: paid default 10,000, configurable to 10M; free 50; **6 simultaneous outgoing connections** |

## Containers (the escape hatch)

GA'ish since 2025; `lite` (1/16 vCPU, 256 MiB) → `standard-4` (4 vCPU, 12 GiB) + custom types; $0.000020/vCPU-s, $0.0000025/GiB-s; scale-to-zero (`sleepAfter`); **1–3 s cold starts**; placement favors image locality over user proximity. Real PHP-FPM/FrankenPHP trivially — at the cost of the isolate model.

## Python Workers — the first-party precedent

Pyodide/CPython **embedded in workerd** (doesn't count against user size limits; dynamic linking shares package wasm across Workers; separate startup budget). **Memory snapshots:** at deploy, top-level scope executes, then **full linear memory snapshot stored alongside the Worker; restored on cold start → ~10× (10 s → 1.027 s mean; vs Lambda 2.5 s, Cloud Run 3.1 s)**. They also rebuild the function-pointer table + JS-reference table from recorded load order, and handle entropy via a deploy-time "poison seed" + post-restore reseed. Userland equivalent for PHP: boot in global scope → `memory.buffer.slice(0)` → per request restore into fresh instance = memcpy instead of interpreter boot.

## Feasibility read — the four walls, in kill-order

1. **1 s startup** spent Liftoff-compiling the wasm per cold start — prototype first, read `startup_time_ms`. *(M1 empirical result: passed with the 10.4 MB binary.)*
2. **128 MB** shared across concurrent requests — one instance + serialized queue, or snapshot-restore.
3. **10 MB gzipped bundle** — survivable; app files go to Static Assets.
4. **No runtime wasm codegen** — interpreter in bundle; fully-static build.

Fine: CPU (5 min max, I/O free), wall clock, isolate reuse, DB connectivity. Free tier is a non-starter → **Workers Paid design**.

Key sources: [limits](https://developers.cloudflare.com/workers/platform/limits/) · [WebAssembly API](https://developers.cloudflare.com/workers/runtime-apis/webassembly/) · [compat flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/) · [workerd src](https://github.com/cloudflare/workerd) (`jsg/setup.c++`, `io/worker.c++`, `io/worker-modules.h`, `io/compatibility-date.capnp`) · [Python Workers](https://developers.cloudflare.com/workers/languages/python/how-python-workers-work/) · [snapshots blog](https://blog.cloudflare.com/python-workers-advancements/) · [TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) · [Hyperdrive](https://developers.cloudflare.com/hyperdrive/platform/limits/) · [D1](https://developers.cloudflare.com/d1/platform/limits/) · [Static Assets binding](https://developers.cloudflare.com/workers/static-assets/binding/) · [subrequests changelog](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/) · [Containers](https://developers.cloudflare.com/containers/)
