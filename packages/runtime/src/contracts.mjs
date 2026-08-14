// The stringly-typed contracts between the JS runtime and PHP userland, named
// once. Everything here is mirrored on the PHP side (workersphp/laravel-bridge
// and any future framework adapter); the shared fixtures in contracts/ at the
// repo root guard both sides against drift.

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

// btoa chokes on large strings built in one go; chunk the conversion.
export const toBase64 = (bytes) => {
	let s = '';
	for (let i = 0; i < bytes.length; i += 0x8000) {
		s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(s);
};

export const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// PHP scripts end by echoing this envelope; the runtime extracts it from the
// interleaved stdout stream.
export const ENVELOPE_RE = /@@ENV@@([A-Za-z0-9+/=]+)@@\/ENV@@/;

// The PHP epilogue that produces a matching envelope. $envelope must be in
// scope in the generated script.
export const PHP_ENVELOPE_EPILOGUE = 'echo "\\n@@ENV@@" . base64_encode(json_encode($envelope)) . "@@/ENV@@\\n";';

// Outbox directories PHP writes during a run and the runtime drains after it.
// The order OUTBOX_FLUSH_ORDER is load-bearing: staged R2 objects must land
// before broadcasts fan out, because receivers fetch object URLs the moment a
// broadcast frame arrives.
export const OUTBOX = {
	mail: '/tmp/outbox',
	queue: '/tmp/queue-outbox',
	r2Staging: '/tmp/r2-staging',
	broadcast: '/tmp/broadcast-outbox',
};

export const extractEnvelope = (stdout) => {
	const match = stdout.match(ENVELOPE_RE);
	return match ? JSON.parse(decoder.decode(fromBase64(match[1]))) : null;
};

// Serialize a meta object for embedding inside a generated PHP script.
export const metaToPhp = (meta) => toBase64(encoder.encode(JSON.stringify(meta)));
