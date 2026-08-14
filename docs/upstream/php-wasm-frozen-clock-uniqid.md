# DRAFT — not filed

- **Target repo:** seanmorris/php-wasm (issue)
- **Also affected, courtesy cross-post candidate:** WordPress/wordpress-playground
- **Files under:** the user's GitHub identity, after their review
- **Suggested title:** uniqid() hangs forever on Cloudflare Workers (workerd): frozen clocks turn its microsecond poll into an infinite loop

---

## Body

PHP builds from this project hang hard inside Cloudflare Workers (workerd)
whenever code calls `uniqid()` more than once per isolate. The first call
returns; every later call spins until the CPU limit kills the request
(observed as `exceededCpu` at 120+ seconds on an otherwise sub-second page).

**Root cause.** As a Spectre mitigation, workerd freezes `Date.now()` and
`performance.now()` during CPU execution — time only advances at I/O
boundaries. PHP's `uniqid()` polls `gettimeofday()` (which Emscripten routes
to `emscripten_date_now`) in a loop until the microsecond value differs from
the previous call's; with a frozen clock that never happens. The same freeze
turns Emscripten's `usleep`/`sleep` busy-waits (on `emscripten_get_now`) into
infinite spins.

This is invisible in local development: `wrangler dev` and Node advance
clocks normally. It only reproduces on deployed workerd, which makes it an
expensive trap for anyone running php-wasm builds on Workers — including
WordPress Playground's JSPI builds if they target Workers.

**Minimal repro** (any php-wasm build on deployed workerd):

```php
<?php
uniqid(); // returns
uniqid(); // spins forever
```

**Fix we ship** (offering to upstream as an opt-in, e.g. a documented
`instantiateWasm` recipe or a flag): wrap the two clock imports so a frozen
clock still advances monotonically by a nudge, and re-syncs whenever real
time moves:

```js
instantiateWasm(info, receive) {
  for (const name of ['emscripten_get_now', 'emscripten_date_now']) {
    const real = info.env[name];
    let last = 0;
    info.env[name] = () => {
      const now = real();
      last = now > last ? now : last + 0.01; // +0.01ms per read while frozen
      return last;
    };
  }
  return receive(new WebAssembly.Instance(wasmModule, info));
}
```

`uniqid()` then yields distinct ids (+10usec apart) and sleeps become
near-no-ops, which is the correct semantic for Workers anyway. Drift is
bounded by 0.01 ms per read and disappears as soon as the real clock
advances.

Happy to send a PR with the wrapper and a docs note if you'd take it.

---

## Notes for the filer

- php-src is deliberately NOT the venue: `uniqid()`'s poll is correct on any
  real clock; the interaction is Emscripten-on-workerd specific.
- The Playground cross-post should reference their JSPI Dockerfile flags
  (which we also use) and note the failure only appears on workerd, not in
  browsers.
