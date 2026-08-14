// Static file concerns: the extension→MIME table, MEMFS-backed public/ file
// serving, and the Static-Assets routing predicate with its bundle-privacy
// guard.

export const STATIC_TYPES = {
	css: 'text/css',
	js: 'text/javascript',
	mjs: 'text/javascript',
	json: 'application/json',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	svg: 'image/svg+xml',
	ico: 'image/x-icon',
	woff: 'font/woff',
	woff2: 'font/woff2',
	ttf: 'font/ttf',
	txt: 'text/plain',
	webp: 'image/webp',
	map: 'application/json',
};

// public/ files (Vite builds, favicons, robots.txt) served straight from the
// mounted filesystem, bypassing PHP entirely.
export const serveStatic = (module, pathname, docroot) => {
	if (!pathname.includes('.') || pathname.endsWith('.php')) return null;
	const path = docroot + pathname;
	const about = module.FS.analyzePath(path);
	if (!about.exists || !module.FS.isFile(about.object.mode)) return null;
	const extension = pathname.split('.').pop().toLowerCase();
	const headers = new Headers({ 'cache-control': 'public, max-age=3600' });
	if (extension in STATIC_TYPES) {
		headers.set('content-type', STATIC_TYPES[extension]);
	}
	return new Response(module.FS.readFile(path, { encoding: 'binary' }), { headers });
};

// The app bundles stay private. Compare DECODED and lowercased: /app%2Ezip
// and /APP.ZIP must not slip past the suffix check.
export const isPrivateBundlePath = (pathname) => {
	let decoded = pathname;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		// Malformed escapes: leave encoded; assets will 404 it anyway.
	}
	return decoded.toLowerCase().endsWith('.zip');
};
