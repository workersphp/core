// The smallest Workers PHP consumer: the framework-agnostic runtime core, the
// vanilla (no-framework) adapter, and one inline index.php. No Laravel
// package anywhere in the import graph — this example is the acceptance
// proof that the runtime is framework-free.
import { createPhpWorker } from '../../../packages/runtime/src/worker.mjs';
import { vanillaAdapter } from '../../../packages/runtime/src/vanilla.mjs';
import { PhpBase } from '../../../packages/runtime/src/phpbase/PhpBase.mjs';
import loader from '@workersphp/php-wasm-jspi/php8.5-web.mjs';
import wasm from '@workersphp/php-wasm-jspi/php8.5-web.mjs.wasm';

const INDEX_PHP = `<?php
if (($_SERVER['REQUEST_URI'] ?? '/') === '/info') {
    phpinfo();
    return;
}
echo "<h1>Hello from PHP " . PHP_VERSION . " inside a Cloudflare Worker isolate</h1>";
echo "<p>Zend Engine compiled to WebAssembly, executing in workerd.</p>";
echo "<p>2 + 2 = " . (2 + 2) . " &middot; " . strtoupper("computed by the zend engine") . "</p>";
echo "<p>Loaded extensions: " . implode(', ', get_loaded_extensions()) . "</p>";
`;

export default createPhpWorker({
	loader,
	wasm,
	PhpBaseClass: PhpBase,
	adapter: vanillaAdapter(),
	appFiles: { '/app/index.php': INDEX_PHP },
});
