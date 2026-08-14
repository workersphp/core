// A completely fresh `laravel new` app, packed by the CLI's pack step and
// served by the runtime + Laravel adapter. This file is the entire Worker.
import { createLaravelWorker } from '@workersphp/laravel';
import loader from '@workersphp/php-wasm-jspi/php8.5-web.mjs';
import wasm from '@workersphp/php-wasm-jspi/php8.5-web.mjs.wasm';

export default createLaravelWorker({
	loader,
	wasm,
	envVars: () => ({
		APP_NAME: 'FreshEdge',
	}),
});
