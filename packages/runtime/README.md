# @workersphp/runtime

The framework-agnostic core of [Workers PHP](https://workersphp.dev): a
resident PHP-in-wasm interpreter per Cloudflare Workers isolate, with a lazy
zip filesystem, an HTTP request bridge, queue and cron entry points, outbox
flushes for mail/queues/storage/broadcasting, the cfbindings handler (KV, R2,
Durable Object cache shards), and Durable Object hubs for WebSocket
broadcasting and atomic cache/locks.

Frameworks plug in as adapters. `@workersphp/laravel` is the first;
`vanillaAdapter` (included) serves plain PHP with no framework at all:

```js
import { createPhpWorker, vanillaAdapter } from '@workersphp/runtime';
import loader from '@workersphp/php-wasm-jspi/php8.5-web.mjs';
import wasm from '@workersphp/php-wasm-jspi/php8.5-web.mjs.wasm';
import { PhpBase } from '@workersphp/runtime/src/phpbase/PhpBase.mjs';

export default createPhpWorker({
  loader, wasm, PhpBaseClass: PhpBase,
  adapter: vanillaAdapter(),
  appFiles: { '/app/index.php': '<?php echo "hello from PHP " . PHP_VERSION;' },
});
```

Most people want the [monorepo](https://github.com/workersphp/core) docs and
`@workersphp/cli` instead of consuming this package directly.
