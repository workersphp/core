// PHP interpreter lifecycle: wasm instantiation (with the production clock
// nudge), OPcache ini defaults, and script execution through pib_run.

// Production workerd freezes clocks during CPU execution (Spectre
// mitigation). Two PHP-level spin patterns then never terminate:
// Emscripten's sleep family busy-waits on emscripten_get_now, and PHP 8.5's
// uniqid() polls gettimeofday (emscripten_date_now) until the microsecond
// changes from its previous call. Local dev advances clocks, which hides
// both. Nudge each clock forward on every read so spins terminate; drift is
// bounded by 0.01ms per call and real time re-syncs whenever it actually
// advances.
export const nudgeClocks = (info) => {
	for (const name of ['emscripten_get_now', 'emscripten_date_now']) {
		const real = info.env[name];
		let last = 0;
		info.env[name] = () => {
			const now = real();
			last = now > last ? now : last + 0.01;
			return last;
		};
	}
};

// OPcache file_cache_only: SHM never works in wasm. With a baked cache the
// file cache is mounted read-only at /opcache (PHP 8.5) — includes load
// pre-compiled opcodes instead of compiling, which removes the fresh-isolate
// compile storm's CPU and its linear-memory allocation spike.
export const opcacheIni = (hasBakedOpcache) => `
	opcache.enable=1
	opcache.enable_cli=1
	opcache.file_cache=/tmp
	opcache.file_cache_only=1
	${hasBakedOpcache ? 'opcache.file_cache_read_only=1' : ''}
	opcache.file_cache_consistency_checks=0
	opcache.validate_timestamps=0
	opcache.use_cwd=0
	opcache.max_accelerated_files=20000
`;

export const createPhp = ({ PhpBaseClass, loader, wasm, ini = '', hasBakedOpcache = false, moduleArgs = {} }) =>
	new PhpBaseClass(Promise.resolve(loader), {
		...moduleArgs,
		ini: opcacheIni(hasBakedOpcache) + ini,
		locateFile: (file) => `https://localhost/${file}`,
		instantiateWasm(info, receive) {
			nudgeClocks(info);
			const instance = new WebAssembly.Instance(wasm, info);
			// Must return receive(instance) — the Asyncify-instrumented exports.
			return receive(instance);
		},
	});

export const runPhp = async (php, code) => {
	const module = await php.binary;
	try {
		return await module.ccall('pib_run', 'number', ['string'], ['?>' + code], { async: true });
	} finally {
		php.flush();
	}
};
