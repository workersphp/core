# @workersphp/cli

One command from a Laravel app to Cloudflare Workers, via
[Workers PHP](https://workersphp.dev).

```sh
cd my-laravel-app
npm install -D @workersphp/cli
composer require workersphp/laravel-bridge
npx workersphp deploy --app . --name my-app --d1 my-db
```

That provisions the D1 database, packs a secret-free zip, publishes static
assets, generates and uploads an APP_KEY secret, and deploys. More flags:
`--queue`, `--broadcast`, `--r2`, `--kv`, `--cron`, `--email`, `--domain`,
`--bake` (production cold-start numbers; needs Docker and Node 24+).

Requires PHP + Composer, `zip`, and a Cloudflare account with
`wrangler login`. Install as a dev dependency of the app (as above): the
generated worker imports `@workersphp/*` packages, which must be resolvable
from the deployment directory. Docs: https://github.com/workersphp/core
