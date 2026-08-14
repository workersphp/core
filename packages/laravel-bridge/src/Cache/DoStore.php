<?php

namespace WorkersPhp\Cloudflare\Cache;

use Illuminate\Contracts\Cache\LockProvider;
use Illuminate\Contracts\Cache\Store;
use WorkersPhp\Cloudflare\Support\CfBindings;

/**
 * The coordination cache: Durable Object shards behind the bridge. Strongly
 * consistent with truly atomic increment/decrement and real locks — the
 * operations KV structurally cannot do. Use for rate limiters, Cache::lock,
 * counters and debouncing; keep read-mostly cache on the KV store.
 *
 * Values are tagged for the wire: numbers ride raw ({n}) so the Durable
 * Object can increment them atomically; everything else is PHP-serialized
 * ({s}).
 */
class DoStore implements Store, LockProvider
{
    public function __construct(private readonly string $prefix = '')
    {
    }

    private function encode(mixed $value): array
    {
        return is_int($value) || is_float($value)
            ? ['n' => $value]
            : ['s' => serialize($value)];
    }

    private function decode(mixed $tagged): mixed
    {
        if (! is_array($tagged)) {
            return null;
        }
        if (array_key_exists('n', $tagged)) {
            return $tagged['n'] + 0;
        }

        return isset($tagged['s']) ? unserialize($tagged['s']) : null;
    }

    public function get($key)
    {
        $tagged = CfBindings::call('docache', 'get', ['key' => $this->prefix . $key]);

        return $tagged === null ? null : $this->decode($tagged);
    }

    public function many(array $keys)
    {
        $results = [];
        foreach ($keys as $key) {
            $results[$key] = $this->get($key);
        }

        return $results;
    }

    public function put($key, $value, $seconds)
    {
        CfBindings::call('docache', 'put', [
            'key' => $this->prefix . $key,
            'value' => $this->encode($value),
            'ttl' => (int) $seconds,
        ]);

        return true;
    }

    public function putMany(array $values, $seconds)
    {
        foreach ($values as $key => $value) {
            $this->put($key, $value, $seconds);
        }

        return true;
    }

    public function increment($key, $value = 1)
    {
        return CfBindings::call('docache', 'increment', [
            'key' => $this->prefix . $key,
            'by' => (int) $value,
        ]);
    }

    public function decrement($key, $value = 1)
    {
        return $this->increment($key, -$value);
    }

    public function forever($key, $value)
    {
        return $this->put($key, $value, 0);
    }

    public function touch($key, $seconds)
    {
        $value = $this->get($key);
        if ($value === null) {
            return false;
        }

        return $this->put($key, $value, $seconds);
    }

    public function forget($key)
    {
        CfBindings::call('docache', 'forget', ['key' => $this->prefix . $key]);

        return true;
    }

    public function flush()
    {
        CfBindings::call('docache', 'flush');

        return true;
    }

    public function getPrefix()
    {
        return $this->prefix;
    }

    public function lock($name, $seconds = 0, $owner = null)
    {
        return new DoLock($this->prefix . $name, $seconds, $owner);
    }

    public function restoreLock($name, $owner)
    {
        return $this->lock($name, 0, $owner);
    }
}
