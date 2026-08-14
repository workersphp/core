<?php

require __DIR__ . '/../vendor/autoload.php';

// The production cf_bindings_call is a C function compiled into the wasm
// binary. Off-Workers it does not exist, so the whole bridge is routed into
// the in-memory fake. Defined globally (not namespace-shadowed) so that
// CfBindings::available() — a global function_exists check — sees it too.
if (! function_exists('cf_bindings_call')) {
    function cf_bindings_call(string $json): string
    {
        return \WorkersPhp\Cloudflare\Testing\FakeCloudflare::handle($json);
    }
}
