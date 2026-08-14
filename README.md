# Workers PHP

PHP 8.5 and Laravel running inside Cloudflare Workers V8 isolates. No servers,
no containers: the Zend Engine is compiled to WebAssembly and lives in the
isolate, your app ships as a lazy-mounted zip, and D1, KV, R2, Queues and
Durable Objects sit behind standard Laravel drivers.

Live proof: **https://workersphp.dev** is a Laravel app (the Chirper tutorial,
grown up) served by this runtime in production. The counter, queue round-trip,
rate limiter and live-photo chirps on that page are real primitives, not
mockups.

## How it works

- **Our own PHP 8.5 binary**: built from php-src via seanmorris/php-wasm with
  JSPI + wasm exceptions (the flag combination WordPress Playground proved
  out) and a custom `cfbindings` C extension: one async JSON entry point that
  suspends the interpreter while a Cloudflare binding call awaits, giving PHP
  synchronous access to KV, R2 and Durable Objects.
- **Resident interpreter per isolate**: embed SAPI, `pib_refresh` between
  requests. Cold isolate boots in about a second of CPU; warm requests run in
  tens of milliseconds.
- **ZipFS**: the app zip stays resident and files hydrate lazily with LRU
  eviction. No extraction step, no 10k-file MEMFS tree.
- **Everything heavy happens at deploy time**: Blade views compile, config
  caches bake, OPcache's file cache is pre-compiled under the exact wasm
  binary the Worker runs. The artifact that reaches the edge just executes.
- **State lives in the right primitive**: D1 (serialized writes), R2 (per-key
  atomic), KV (eventual, read-mostly), cookie sessions, and Durable Objects as
  coordination components: a WebSocket broadcast hub speaking the Pusher
  protocol subset (stock Laravel Echo works), and sharded cache objects giving
  Laravel atomic counters and real `Cache::lock()` across isolates.

## Quickstart

Prerequisites: Node 20+ (24+ for `--bake`), PHP 8.3+ with Composer, `zip`,
Docker (only for `--bake`), and a Cloudflare account with `wrangler login`.

```sh
cd my-laravel-app
npm install -D @workersphp/cli
composer require workersphp/laravel-bridge
npx workersphp deploy --app . --name my-app --d1 my-db
```

(The CLI installs as a dev dependency of the app, wrangler-style: the worker
it generates imports `@workersphp/*` packages, which must be resolvable from
the deployment directory.)

That provisions the D1 database, packs a secret-free zip, publishes static
assets, generates and uploads an `APP_KEY` secret, and deploys. Add
`--queue jobs --broadcast --r2 uploads --kv cache --cron '* * * * *'` to light
up the rest of the driver grid, `--bake` for production cold-start numbers,
and `--domain example.com` to attach a custom domain.

The Laravel side is one composer package:

```sh
composer require workersphp/laravel-bridge
```

It registers normal Laravel drivers (database `cfd1`, cache stores `kv` and
`do`, filesystem `r2`, queue/mail/broadcast `cloudflare`) that only activate
when selected by configuration. On a regular server the package is inert:
the same codebase deploys to Workers and to a VPS with nothing but env
changes.

## The compatibility boundary

Be honest with yourself about this part before shipping:

- **No outbound HTTP from PHP.** `Http::`, Guzzle and raw sockets fail: wasm
  has no network stack. A fetch bridge over cfbindings is the top roadmap
  item.
- **No `gd`, `imagick`, `intl` or `iconv`.** No image manipulation in PHP.
- **No `exec`, `proc_open` or Symfony Process.** Never run Artisan inside the
  Worker; the CLI runs it at build time instead.
- `sleep()` and `usleep()` are no-ops.
- Requests serialize per isolate (Cloudflare spreads load across many
  isolates; a single isolate handles one PHP request at a time).

Official Laravel starter kits run unmodified. Apps that stay within this
boundary swap between edge and server with configuration only.

## Packages

| Package | Registry | What it is |
|---|---|---|
| `@workersphp/runtime` | npm | Framework-agnostic core: wasm lifecycle, ZipFS, request bridge, outboxes, cfbindings handler, Durable Object hubs |
| `@workersphp/laravel` | npm | The Laravel adapter: dispatch scripts, warmup, bake/pack tooling |
| `@workersphp/cli` | npm | `workersphp deploy`: provision, pack, bake, publish, deploy |
| `workersphp/laravel-bridge` | Packagist | Laravel drivers for D1, KV, DO cache/locks, R2, Queues, broadcasting, mail |
| `@workersphp/php-wasm-jspi` | npm | The PHP 8.5 wasm binary + Emscripten glue, with provenance |

The runtime is framework-agnostic by construction: a framework plugs in as an
adapter object (request/job/schedule script builders plus boot conventions).
The `vanillaAdapter` serves plain PHP with no framework at all, and a Drupal
adapter is the roadmap's proof that the boundary holds.

## Rebuilding the binary

The wasm binary is reproducible from `build-php/REBUILD.md`: a disposable
seanmorris/php-wasm checkout, six patches (all in `build-php/patches/`), and a
Docker build. The binary package publishes sha256 checksums and the exact
`.php-wasm-rc` build configuration. `build-php/ext-cfbindings/` is the whole
C extension: 89 lines, one function.

## Roadmap

- Outbound HTTP from PHP (fetch bridge over cfbindings)
- Session driver on KV or Durable Objects
- Memory snapshots for sub-100ms cold boots
- A second framework adapter (Drupal)

## Credits and prior art

Workers PHP stands on prior art it is glad to name:

- [togishima/laravel-edge](https://github.com/togishima/laravel-edge), the
  pioneer: the first shipped Laravel-on-Workers, whose embed-SAPI plus
  resident-interpreter architecture this project built on, and whose war
  stories saved weeks.
- [seanmorris/php-wasm](https://github.com/seanmorris/php-wasm), the build
  system our binaries are produced with, and
  [seanmorris/pdo-cfd1](https://github.com/seanmorris/pdo-cfd1), the D1 PDO
  driver.
- [WordPress Playground](https://github.com/WordPress/wordpress-playground),
  whose JSPI plus wasm-exceptions flag combination showed the way out of the
  Asyncify/setjmp wall.
- [Matthieu Napoli](https://github.com/mnapoli), OPcache file-cache warmup
  prior art from PHP on Lambda (Bref).

This is a community project, not affiliated with or endorsed by Cloudflare or
Laravel. "Laravel" is a trademark of Taylor Otwell; "Cloudflare" and
"Workers" are trademarks of Cloudflare, Inc.

## License

MIT (see LICENSE). The distributed wasm binary bundles software under its own
licenses; see NOTICE and the LICENSES directory inside the binary package.
