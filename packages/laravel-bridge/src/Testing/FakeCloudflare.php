<?php

namespace WorkersPhp\Cloudflare\Testing;

/**
 * In-memory implementation of the Worker's cfbindings handler, mirroring the
 * runtime's semantics (bindings handler in the runtime worker + CacheHub
 * Durable Object) so package and application code can be tested off-Workers.
 *
 * Wire this up in a phpunit bootstrap:
 *
 *     if (! function_exists('cf_bindings_call')) {
 *         function cf_bindings_call(string $json): string {
 *             return \WorkersPhp\Cloudflare\Testing\FakeCloudflare::handle($json);
 *         }
 *     }
 *
 * Faithfulness notes (each mirrors a production behavior):
 * - kv put clamps TTL to >= 60 seconds, as Workers KV requires.
 * - docache values are stored tagged ({n: number} | {s: serialized}); the
 *   fake, like the Durable Object, never interprets {s} payloads.
 * - docache increment reads the {n} tag (0 when absent or non-numeric) and
 *   preserves an existing entry's expiry.
 * - locks live under a "lock:" key prefix; acquisition fails only when a
 *   different owner holds a live lock; unlock with owner null force-releases.
 * - r2 bodies cross base64-encoded both ways.
 * - Divergence: the fake is one flat store (production shards docache across
 *   16 Durable Objects by djb2 hash — a routing detail, not a semantic) and
 *   r2 list never paginates (truncated is always false).
 */
class FakeCloudflare
{
    /** @var array<string, array{value: string, ttl: ?int}> */
    public static array $kv = [];

    /** @var array<string, array{value: mixed, expiresAt: ?float}> */
    public static array $docache = [];

    /** @var array<string, array{body: string, contentType: ?string, uploaded: string, size: int}> */
    public static array $r2 = [];

    /** @var list<array{kind: string, op: string, args: array}> */
    public static array $calls = [];

    public static function reset(): void
    {
        self::$kv = [];
        self::$docache = [];
        self::$r2 = [];
        self::$calls = [];
    }

    public static function handle(string $requestJson): string
    {
        try {
            $request = json_decode($requestJson, true, flags: JSON_THROW_ON_ERROR);
            self::$calls[] = [
                'kind' => $request['kind'] ?? '?',
                'op' => $request['op'] ?? '?',
                'args' => $request['args'] ?? [],
            ];
            $value = self::dispatch($request['kind'], $request['op'], $request['args'] ?? []);

            return json_encode(['ok' => true, 'value' => $value], JSON_THROW_ON_ERROR);
        } catch (\Throwable $e) {
            return json_encode(['ok' => false, 'error' => $e->getMessage()]);
        }
    }

    private static function dispatch(string $kind, string $op, array $args): mixed
    {
        return match ($kind) {
            'kv' => self::kv($op, $args),
            'docache' => self::docache($op, $args),
            'r2' => self::r2($op, $args),
            default => throw new \RuntimeException("unknown binding kind: {$kind}"),
        };
    }

    private static function kv(string $op, array $args): mixed
    {
        switch ($op) {
            case 'get':
                return self::$kv[$args['key']]['value'] ?? null;
            case 'put':
                self::$kv[$args['key']] = [
                    'value' => $args['value'],
                    // Mirrors the runtime: expirationTtl is clamped to KV's minimum.
                    'ttl' => isset($args['ttl']) && $args['ttl'] ? max(60, (int) $args['ttl']) : null,
                ];

                return true;
            case 'delete':
                unset(self::$kv[$args['key']]);

                return true;
        }
        throw new \RuntimeException("unknown kv op: {$op}");
    }

    private static function live(string $key): mixed
    {
        $entry = self::$docache[$key] ?? null;
        if ($entry === null) {
            return null;
        }
        if ($entry['expiresAt'] !== null && $entry['expiresAt'] <= microtime(true) * 1000) {
            unset(self::$docache[$key]);

            return null;
        }

        return $entry;
    }

    private static function docache(string $op, array $args): mixed
    {
        switch ($op) {
            case 'get':
                return self::live($args['key'])['value'] ?? null;
            case 'put':
                self::$docache[$args['key']] = [
                    'value' => $args['value'],
                    'expiresAt' => ($args['ttl'] ?? 0) ? microtime(true) * 1000 + $args['ttl'] * 1000 : null,
                ];

                return true;
            case 'forget':
                unset(self::$docache[$args['key']]);

                return true;
            case 'increment': {
                $entry = self::live($args['key']);
                $current = $entry === null ? 0 : (float) ($entry['value']['n'] ?? 0);
                $next = $current + ($args['by'] ?? 1);
                // Ints stay ints on the wire, as in JS where 3 + 1 is 4, not 4.0.
                $next = fmod($next, 1.0) === 0.0 ? (int) $next : $next;
                self::$docache[$args['key']] = [
                    'value' => ['n' => $next],
                    'expiresAt' => $entry === null ? null : $entry['expiresAt'],
                ];

                return $next;
            }
            case 'lock': {
                $key = 'lock:' . $args['key'];
                $existing = self::live($key);
                if ($existing !== null && $existing['value'] !== $args['owner']) {
                    return false;
                }
                self::$docache[$key] = [
                    'value' => $args['owner'],
                    'expiresAt' => ($args['ttl'] ?? 0) ? microtime(true) * 1000 + $args['ttl'] * 1000 : null,
                ];

                return true;
            }
            case 'unlock': {
                $key = 'lock:' . $args['key'];
                $existing = self::live($key);
                if ($existing === null) {
                    return true;
                }
                if ($existing['value'] !== ($args['owner'] ?? null) && ($args['owner'] ?? null) !== null) {
                    return false;
                }
                unset(self::$docache[$key]);

                return true;
            }
            case 'lockOwner':
                return self::live('lock:' . $args['key'])['value'] ?? null;
            case 'flush':
                self::$docache = [];

                return true;
        }
        throw new \RuntimeException("unknown docache op: {$op}");
    }

    private static function r2(string $op, array $args): mixed
    {
        switch ($op) {
            case 'get': {
                $object = self::$r2[$args['key']] ?? null;

                return $object === null ? null : [
                    'body' => $object['body'],
                    'size' => $object['size'],
                    'etag' => md5($object['body']),
                    'uploaded' => $object['uploaded'],
                    'contentType' => $object['contentType'],
                ];
            }
            case 'head': {
                $object = self::$r2[$args['key']] ?? null;

                return $object === null ? null : [
                    'size' => $object['size'],
                    'etag' => md5($object['body']),
                    'uploaded' => $object['uploaded'],
                    'contentType' => $object['contentType'],
                ];
            }
            case 'put':
                self::$r2[$args['key']] = [
                    'body' => $args['body'] ?? '',
                    'contentType' => $args['contentType'] ?? null,
                    'uploaded' => gmdate('c'),
                    'size' => strlen(base64_decode($args['body'] ?? '')),
                ];

                return true;
            case 'delete':
                foreach ((array) ($args['keys'] ?? $args['key']) as $key) {
                    unset(self::$r2[$key]);
                }

                return true;
            case 'list': {
                $prefix = $args['prefix'] ?? '';
                $delimiter = $args['delimiter'] ?? null;
                $objects = [];
                $prefixes = [];
                foreach (self::$r2 as $key => $object) {
                    if ($prefix !== '' && ! str_starts_with($key, $prefix)) {
                        continue;
                    }
                    $rest = substr($key, strlen($prefix));
                    if ($delimiter !== null && ($pos = strpos($rest, $delimiter)) !== false) {
                        $prefixes[$prefix . substr($rest, 0, $pos + 1)] = true;
                        continue;
                    }
                    $objects[] = ['key' => $key, 'size' => $object['size'], 'uploaded' => $object['uploaded']];
                }

                return [
                    'objects' => $objects,
                    'delimitedPrefixes' => array_keys($prefixes),
                    'truncated' => false,
                    'cursor' => null,
                ];
            }
        }
        throw new \RuntimeException("unknown r2 op: {$op}");
    }
}
