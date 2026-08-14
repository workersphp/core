<?php

namespace WorkersPhp\Cloudflare\Support;

use RuntimeException;

/**
 * PHP side of the cfbindings bridge: one JSON round trip per operation into
 * the Worker's binding handler. The extension suspends the interpreter while
 * the binding call awaits — synchronous PHP semantics over async bindings.
 */
class CfBindings
{
    public static function available(): bool
    {
        return function_exists('cf_bindings_call');
    }

    /**
     * @throws RuntimeException when the bridge is missing or the call fails
     */
    public static function call(string $kind, string $op, array $args = []): mixed
    {
        if (! self::available()) {
            throw new RuntimeException(
                'cfbindings extension is not compiled into this PHP build',
            );
        }

        $response = json_decode(cf_bindings_call(json_encode([
            'kind' => $kind,
            'op' => $op,
            'args' => $args,
        ], JSON_THROW_ON_ERROR)), true);

        if (! is_array($response) || ! ($response['ok'] ?? false)) {
            throw new RuntimeException(
                "cfbindings {$kind}.{$op} failed: " . ($response['error'] ?? 'malformed response'),
            );
        }

        return $response['value'];
    }
}
