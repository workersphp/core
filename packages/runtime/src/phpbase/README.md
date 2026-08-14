Emscripten-side glue from seanmorris/php-wasm (Apache-2.0; see the repository
NOTICE). Vendored verbatim: PhpBase drives the compiled module (event-based
stdio, refresh lifecycle) and is variant-agnostic, so one copy serves every
binary build. Update by copying from a php-wasm checkout's source/ directory.
