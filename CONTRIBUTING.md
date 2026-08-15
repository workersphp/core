# Contributing

## Layout

One monorepo. `packages/runtime` (framework-agnostic core), `packages/laravel`
(Laravel adapter + build tooling), `packages/cli` (deploy command),
`packages/laravel-bridge` (composer drivers), `build-php/` (binary recipe:
rc file, patches, the cfbindings C extension, REBUILD.md), `examples/`,
`contracts/` (cross-language fixtures shared by the JS and PHP test suites).

`workersphp/laravel-bridge` on Packagist is a read-only mirror, updated by
the maintainer from this repository. Issues and pull requests belong here,
not there.

## Running the tests

```sh
npm ci
node --experimental-wasm-jspi --test packages/runtime/test/*.test.mjs packages/cli/test/*.test.mjs
cd packages/laravel-bridge && composer install && vendor/bin/phpunit
```

Node 24+ is required for the JSPI tests. The frozen-clock test is the one
that guards the production-only failure mode; treat it as sacred.

## Ground rules

- The runtime never imports framework knowledge. Anything Laravel-shaped goes
  in the adapter (`packages/laravel`) or the composer package.
- The bridge contracts (outbox file shapes, `{n}`/`{s}` cache tags, envelope
  format, shard hashing) are pinned by `contracts/*.json`. A change there
  must update both the JS and PHP sides and their tests in the same commit.
- The Durable Object migrations ledger in generated wrangler configs is
  append-only. Never reorder, rename or remove entries.
- Rebuilding the PHP binary follows `build-php/REBUILD.md`; binary changes
  ship as a new `@workersphp/php-wasm-jspi` version with fresh checksums.
