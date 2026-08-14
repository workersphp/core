// Production probe for workerd's frozen-clock semantics against the JSPI
// binary. Each suspect primitive is its own route so a hang kills only that
// request; ?nowrap=1 disables the clock-nudge wrap for A/B comparison.
import { PhpBase } from '../../../packages/runtime/vendor/php-wasm-85-jspi/PhpBase.mjs';
import '../../../packages/runtime/src/shims.mjs';
import loader from '../../../packages/runtime/vendor/php-wasm-85-jspi/php8.5-web.mjs';
import wasm from '../../../packages/runtime/vendor/php-wasm-85-jspi/php8.5-web.mjs.wasm';

const CASES = {
	control: 'echo "control ", 1 + 1;',
	usleep1: '$t = microtime(true); usleep(1); echo "usleep1 ok ", round((microtime(true) - $t) * 1000, 3), "ms";',
	usleep100k: '$t = microtime(true); usleep(100000); echo "usleep100k ok ", round((microtime(true) - $t) * 1000, 1), "ms";',
	uniqid: 'echo "uniqid ", uniqid();',
	uniqid4: 'echo "uniqid4 ", uniqid(), " ", uniqid(), " ", uniqid(), " ", uniqid();',
	microtimeloop: '$n = 0; for ($i = 0; $i < 1000; $i++) { $n += microtime(true); } echo "microtimeloop ok";',
	hrtimeloop: '$n = 0; for ($i = 0; $i < 1000; $i++) { $n += hrtime(true); } echo "hrtimeloop ok";',
	datetime: 'echo "datetime ", (new DateTime())->format("Y-m-d H:i:s.u");',
	bridge: '$r = cf_bindings_call(json_encode(["kind"=>"kv","op"=>"get","args"=>["key"=>"probe"]])); echo "bridge ", $r;',
	sleep1: '$t = microtime(true); sleep(1); echo "sleep1 ok ", round(microtime(true) - $t, 2), "s";',
};

const instances = {};

function boot(wrapClock) {
	const php = new PhpBase(Promise.resolve(loader), {
		cfbindings: async ({ kind, op, args }) => `mock:${kind}.${op}:${args?.key ?? ''}`,
		ini: 'date.timezone=UTC\nopcache.enable=0\n',
		locateFile: (file) => `https://localhost/${file}`,
		instantiateWasm(info, receive) {
			if (wrapClock) {
				for (const name of ['emscripten_get_now', 'emscripten_date_now']) {
					const real = info.env[name];
					let last = 0;
					info.env[name] = () => {
						const now = real();
						last = now > last ? now : last + 0.01;
						return last;
					};
				}
			}
			return receive(new WebAssembly.Instance(wasm, info));
		},
	});
	return php;
}

export default {
	async fetch(request) {
		const url = new URL(request.url);
		const name = url.pathname.replace(/^\/+/, '');
		if (!(name in CASES)) {
			return new Response('cases: ' + Object.keys(CASES).join(' ') + '\n');
		}
		const wrapClock = url.searchParams.get('nowrap') !== '1';
		const key = wrapClock ? 'wrapped' : 'raw';
		instances[key] ??= boot(wrapClock);
		const php = instances[key];
		const module = await php.binary;

		let out = '';
		const collect = (e) => (out += e.detail);
		php.addEventListener('output', collect);
		php.addEventListener('error', collect);
		const started = Date.now();
		let rc;
		try {
			rc = await module.ccall('pib_run', 'number', ['string'], ['?><?php ' + CASES[name]], { async: true });
		} finally {
			php.flush();
			php.removeEventListener('output', collect);
			php.removeEventListener('error', collect);
		}
		return new Response(`case=${name} clock=${key} rc=${rc} wall=${Date.now() - started}ms\n${out}\n`);
	},
};
