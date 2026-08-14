# workersphp/laravel-bridge

Cloudflare-native Laravel drivers for [Workers PHP](https://workersphp.dev),
the runtime that executes PHP 8.5 inside Cloudflare Workers V8 isolates:

- Database: `cfd1` connection over Cloudflare D1
- Cache: `kv` store (Workers KV, read-mostly) and `do` store (Durable Object
  shards with atomic increments and real `Cache::lock()`)
- Filesystem: `r2` disk (Cloudflare R2)
- Queue, mail and broadcasting drivers that ride the runtime's outbox pattern
- A fileinfo polyfill and MIME guesser for the wasm environment

Every driver is opt-in through standard Laravel configuration and inert on a
regular server, so one codebase deploys to Workers and to a VPS with nothing
but env changes.

```sh
composer require workersphp/laravel-bridge
```

This repository is a read-only mirror of
[workersphp/core](https://github.com/workersphp/core), where the docs,
issues and pull requests live. Deploying needs the other half of the
project: see the monorepo README for the full quickstart.

## Credits

The `cfd1` driver registration follows the approach pioneered by
[togishima/laravel-edge](https://github.com/togishima/laravel-edge) (MIT),
the first shipped Laravel-on-Workers, and rides the `pdo_cfd1` PDO driver by
[Sean Morris](https://github.com/seanmorris/pdo-cfd1) compiled into the
runtime binary.

Workers PHP is a community project. It is not affiliated with or endorsed by
Cloudflare or Laravel.

## License

MIT.
