# M6 Fast-Track Results — Laravel 13 Live on workers.dev

**Date:** 2026-08-13 · **Status: LARAVEL RUNS IN PRODUCTION**

Live at the time: a private workers.dev deployment (retired); the production successor is https://workersphp.dev

| Route | What it proves | Verified |
|---|---|---|
| `/` | Blade welcome view renders | ✅ 200 |
| `/hello` | **D1 via pdo_cfd1 through Laravel's DB layer** + Blade with data | ✅ counter 1→2 in prod |
| `/counter` | Cookie-driver sessions (cross-isolate safe) | ✅ 1→2→3 |
| `/info` | PHP 8.5.2 embed SAPI, Laravel 13.22.0, OPcache file_cache enabled, config cached | ✅ |
| `/up` | Laravel health route | ✅ |

## Production numbers (wrangler tail)

- **Cold request (isolate boot: zip extract 6.2 MB → MEMFS, .env gen, config cache + Blade
  precompile warmup, then the request): ~2.4–2.5 s CPU / ~3 s wall.**
- **Warm requests: 94–179 ms CPU.**
- Bundle: 23.9 MB raw / **6.6 MB gzip** + 6.2 MB app zip as Static Asset (outside bundle).
- Cloudflare load-balances across isolates, so early traffic pays several cold boots
  (visible as alternating warm/cold in the tail log). This makes the M7 snapshot/boot-cost
  work the top perf priority.

## How it's assembled

- **Payload:** laravel-edge's `app13` (Laravel 13.22, composer install --no-dev,
  classmap-authoritative, Carbon locales pruned, **secret-free zip** — 6.2 MB) served via
  Static Assets with `run_worker_first: true`; extracted into MEMFS at boot by PHP's ZipArchive.
- **Runtime:** our vendored static PHP 8.5.2 (`packages/runtime/vendor/php-wasm-85/`),
  resident per isolate, `pib_refresh` between requests, request/response via the
  base64-envelope dispatcher (`examples/laravel/src/index.mjs`, adapted from laravel-edge).
- **.env generated at boot** from the `APP_KEY` Workers secret (cookie sessions, stderr logs,
  array cache, `DB_CONNECTION=cfd1`).
- **D1:** database `php-v8-laravel` (<redacted>), reached from PHP
  as `new PDO('cfd1:DB')`, guarded on the JS side by a query allow-list.

## Bug found & fixed in the prior art

laravel-edge's published repo is missing `app13/app/` — their root `.gitignore` has `app/`
(an old local experiment) which accidentally ignores `app13/app/` too. Without it Laravel
boots (provider loading tolerates the missing class) but `/hello` dies with
`Unsupported driver [cfd1]`. We reconstructed `App\Providers\AppServiceProvider`:
`Connection::resolverFor('cfd1', ...)` → `new PDO('cfd1:'.$database)` wrapped in a
`SQLiteConnection`, with `foreign_key_constraints` stripped so no PRAGMA hits the D1 guard.
Worth reporting upstream.

## What this changes about the plan

M6's existence question is answered. What remains is making this a *runtime product*
rather than a hand-assembled deployment:
- **M4 packer:** `composer install → prune → optimize → zip → assets` as a CLI for any app
  (today it's laravel-edge's shell script + hand steps).
- **M5 generalization:** session/cache/queue driver mapping to KV/D1/Queues (app13 uses
  cookie/array only), R2 storage disk, mail via HTTP APIs.
- **M6 proper:** fresh `laravel new` through our own tooling (no app13 scaffolding).
- **M7 priority: cold-boot cost** — ~2.5 s CPU per fresh isolate. Options: userland linear-
  memory snapshot after warmup (Python Workers technique), streaming the zip extraction,
  precompiled OPcache file-cache shipped in the zip, `smart placement`, or a DO front to
  pin traffic to warm isolates.
