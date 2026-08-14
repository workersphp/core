// Minimal browser-global shims for running Emscripten web builds under workerd.
// Derived from togishima/laravel-edge (MIT) src/shims.mjs — battle-tested set.
globalThis.document ??= { currentScript: null, querySelector: () => null };
if (!('window' in globalThis)) globalThis.window = undefined;
if (!('screen' in globalThis)) globalThis.screen = undefined;
globalThis.location ??= { href: 'https://localhost/' };
// Without setImmediate, Emscripten falls back to addEventListener('message', cb, true),
// and workerd rejects useCapture=true.
globalThis.setImmediate ??= (fn) => setTimeout(fn, 0);
// ENVIRONMENT_IS_WORKER = typeof importScripts === 'function'
globalThis.importScripts ??= () => {
	throw new Error('importScripts is not supported in workerd');
};
globalThis.self ??= globalThis;
