# Changelog

All notable changes to this project will be documented in this file. The
format follows Keep a Changelog; versions follow semver (0.x: expect movement).

## [Unreleased]

## [0.1.0] - TBD

Initial public release.

- Framework-agnostic runtime (`@workersphp/runtime`): resident PHP 8.5 wasm
  interpreter per isolate, ZipFS lazy filesystem, request bridge, outbox
  flushes, cfbindings handler, BroadcastHub and CacheHub Durable Objects,
  frozen-clock nudge.
- Laravel adapter (`@workersphp/laravel`): dispatch scripts, warmup,
  pack/bake toolchain.
- Deploy CLI (`@workersphp/cli`): `workersphp deploy` provisions D1, Queues,
  R2 and KV, packs, bakes and deploys in one command.
- Laravel drivers (`workersphp/laravel-bridge`): cfd1 database, kv and do
  cache stores (atomic counters + real locks), r2 filesystem, cloudflare
  queue/mail/broadcast drivers, fileinfo polyfill, wasm MIME guesser.
- PHP 8.5.2 binary (`@workersphp/php-wasm-jspi`): JSPI + wasm exceptions +
  cfbindings, reproducible from build-php/REBUILD.md.
