# @workersphp/php-wasm-jspi

PHP 8.5.2 compiled to WebAssembly for Cloudflare Workers isolates.

Build characteristics:

- Emscripten static build (embed SAPI, `MAIN_MODULE=0`) via
  [seanmorris/php-wasm](https://github.com/seanmorris/php-wasm)
- `ASYNCIFY=2` (JSPI) with native wasm exceptions
  (`-sSUPPORT_LONGJMP=wasm -fwasm-exceptions`)
- Extensions include: sqlite3, pdo_cfd1 (Cloudflare D1), mbstring, openssl,
  zlib, zip, dom/libxml/xml/simplexml/xmlreader/xmlwriter, bcmath, and the
  `cfbindings` bridge extension (one async JSON entry point into the Worker's
  configured bindings)
- `INITIAL_MEMORY=48MB`

Provenance: reproducible from the `build-php/` directory of the Workers PHP
monorepo (`.php-wasm-rc` build configuration, six patches, REBUILD.md). Each
published version lists sha256 checksums here:

```
  9e90ffbb7db5598ba7f87e20744f065816297d0acf9ed587ff051deb1ba60074  php8.5-web.mjs
  14c995d4d48e3f95068a92abf25cd8bf83e75ff80e73dc7e7405681bc534ecb5  php8.5-web.mjs.wasm
```

This package contains no JavaScript logic beyond the Emscripten glue; the
runtime that drives it is `@workersphp/runtime`.

Licensing: the binary is a derived work of PHP (PHP License 3.01), php-wasm
and pdo-cfd1 (Apache-2.0, with modifications stated in the monorepo's
build-php/patches/), and statically linked libraries; see NOTICE and
LICENSES/. This product includes PHP software, freely available from
<https://www.php.net/software/>.
