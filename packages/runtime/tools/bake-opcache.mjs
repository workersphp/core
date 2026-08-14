#!/usr/bin/env node
// Bake the OPcache file cache under the EXACT wasm binary the Worker runs.
//
//   node bake-opcache.mjs <app.zip> <opcache.zip>
//
// zend_system_id is a pure function of the PHP binary, so .bin files generated
// here load in workerd (PHP 8.5's opcache.file_cache_read_only exists for this).
// Compilation does not require execution: opcache_compile_file() over the
// composer classmap + app code + compiled views caches everything a request
// would otherwise compile on the fly. Paths must match production exactly
// (/app, /opcache), which they do because the same ZipFS mounts the same zip.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const runtime = resolve(here, '..');

const [appZipPath, outZipPath] = process.argv.slice(2, 4).map((p) => p && resolve(p));
// The cache is keyed to zend_system_id — a pure function of the binary — so the
// vendor dir MUST be the one the deployment imports. JSPI variants additionally
// need a JSPI-capable Node (24+, --experimental-wasm-jspi).
const vendorDir = process.argv[4] || 'php-wasm-85-jspi';
// The production binary ships as its own package; alternate variants live in
// the runtime vendor dir (private monorepo only).
const binDir = vendorDir === 'php-wasm-85-jspi'
	? resolve(runtime, '../php-wasm-jspi')
	: join(runtime, 'vendor', vendorDir);
if (!appZipPath || !outZipPath) {
	console.error('usage: bake-opcache.mjs <app.zip> <opcache.zip> [vendor-dir]');
	process.exit(1);
}

process.env.TZ = 'UTC';

const { PhpBase } = await import(join(runtime, 'src/phpbase/PhpBase.mjs'));
const { default: loader } = await import(join(binDir, 'php8.5-web.mjs'));
const { mountZip } = await import(join(runtime, 'src/ZipFS.mjs'));
await import(join(runtime, 'src/shims.mjs'));

const wasmBytes = readFileSync(join(binDir, 'php8.5-web.mjs.wasm'));
const wasmModule = await WebAssembly.compile(wasmBytes);

const php = new PhpBase(Promise.resolve(loader), {
	ini: `
		date.timezone=UTC
		opcache.enable=1
		opcache.enable_cli=1
		opcache.file_cache=/tmp
		opcache.file_cache_only=1
		opcache.validate_timestamps=0
		opcache.file_cache_consistency_checks=0
		opcache.use_cwd=0
		opcache.max_accelerated_files=20000
	`,
	locateFile: (file) => file,
	instantiateWasm(info, receive) {
		const instance = new WebAssembly.Instance(wasmModule, info);
		return receive(instance);
	},
});

const module = await php.binary;
const zipBytes = new Uint8Array(readFileSync(appZipPath));
mountZip(module.FS, zipBytes, '/app', 64 * 1024 * 1024);

const run = async (code) => {
	let out = '';
	const collect = (e) => (out += e.detail);
	php.addEventListener('output', collect);
	php.addEventListener('error', collect);
	try {
		await module.ccall('pib_run', 'number', ['string'], ['?>' + code], { async: true });
	} finally {
		php.flush();
		php.removeEventListener('output', collect);
		php.removeEventListener('error', collect);
	}
	return out;
};

console.error('[opcache-bake] compiling classmap + views');
const summary = await run(`<?php
$targets = [];
// Curated hot set: the frameworks a request actually loads. A blanket bake of
// the full classmap produced a 17.5MB cache zip whose residency offset the
// lazy-FS savings.
$hot = [
    '/app/vendor/laravel/framework/src/Illuminate/',
    '/app/vendor/livewire/',
    '/app/vendor/symfony/http-foundation/',
    '/app/vendor/symfony/http-kernel/',
    '/app/vendor/symfony/routing/',
    '/app/vendor/symfony/finder/',
    '/app/vendor/symfony/console/',
    '/app/vendor/psr/',
    '/app/vendor/composer/',
    '/app/app/',
];
$classmap = @include '/app/vendor/composer/autoload_classmap.php';
if (is_array($classmap)) {
    foreach ($classmap as $file) {
        foreach ($hot as $prefix) {
            if (str_starts_with($file, $prefix)) { $targets[$file] = true; break; }
        }
    }
}
foreach (['/app/vendor/composer', '/app/bootstrap', '/app/routes', '/app/config', '/app/public'] as $dir) {
    if (!is_dir($dir)) continue;
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS));
    foreach ($it as $f) {
        if ($f->isFile() && str_ends_with($f->getPathname(), '.php')) { $targets[$f->getPathname()] = true; }
    }
}
if (is_dir('/app/storage/framework/views')) {
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator('/app/storage/framework/views', FilesystemIterator::SKIP_DOTS));
    foreach ($it as $f) {
        if ($f->isFile() && str_ends_with($f->getPathname(), '.php')) { $targets[$f->getPathname()] = true; }
    }
}
$ok = 0; $fail = 0;
foreach (array_keys($targets) as $file) {
    try {
        if (@opcache_compile_file($file)) { $ok++; } else { $fail++; }
    } catch (Throwable $e) { $fail++; }
}
echo "compiled=$ok failed=$fail\\n";
`);
console.error('[opcache-bake] ' + summary.trim().split('\n').pop());

// Export /opcache from MEMFS into a zip on the host.
const stage = mkdtempSync(join(tmpdir(), 'opcache-'));
let exported = 0;
const walk = (dir) => {
	for (const entry of module.FS.readdir(dir)) {
		if (entry === '.' || entry === '..') continue;
		const path = `${dir}/${entry}`;
		const stat = module.FS.stat(path);
		const rel = path.slice('/tmp/'.length);
		if (module.FS.isDir(stat.mode)) {
			execFileSync('mkdir', ['-p', join(stage, rel)]);
			walk(path);
		} else {
			writeFileSync(join(stage, rel), module.FS.readFile(path));
			exported++;
		}
	}
};
walk('/tmp');
console.error(`[opcache-bake] exported ${exported} cache files`);

rmSync(outZipPath, { force: true });
execFileSync('zip', ['-qr', outZipPath, '.'], { cwd: stage });
rmSync(stage, { recursive: true, force: true });

const size = readFileSync(outZipPath).byteLength;
console.error(`[opcache-bake] done: ${outZipPath} (${(size / 1048576).toFixed(1)} MB)`);
if (size > 24 * 1024 * 1024) {
	console.error('[opcache-bake] WARNING: exceeds the 25 MiB asset cap — curate the target list');
	process.exit(2);
}
process.exit(0);
