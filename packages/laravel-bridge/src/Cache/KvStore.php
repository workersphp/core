<?php

namespace WorkersPhp\Cloudflare\Cache;

use Illuminate\Contracts\Cache\Store;
use WorkersPhp\Cloudflare\Support\CfBindings;

/**
 * Workers KV as a Laravel cache store. KV semantics apply: eventually
 * consistent across colos (~60s), one write per second per key, minimum TTL
 * of 60 seconds. Ideal for read-mostly cache; increment/decrement are
 * read-modify-write and NOT atomic. flush() is a no-op — KV has no cheap
 * namespace wipe; use versioned prefixes if you need one.
 */
class KvStore implements Store
{
    public function __construct(private readonly string $prefix = '')
    {
    }

    public function get($key)
    {
        $raw = CfBindings::call('kv', 'get', ['key' => $this->prefix . $key]);

        return is_string($raw) ? unserialize($raw) : null;
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
        CfBindings::call('kv', 'put', [
            'key' => $this->prefix . $key,
            'value' => serialize($value),
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
        $current = (int) ($this->get($key) ?? 0);
        $next = $current + $value;
        $this->forever($key, $next);

        return $next;
    }

    public function decrement($key, $value = 1)
    {
        return $this->increment($key, -$value);
    }

    public function touch($key, $seconds)
    {
        $value = $this->get($key);
        if ($value === null) {
            return false;
        }

        return $this->put($key, $value, $seconds);
    }

    public function forever($key, $value)
    {
        CfBindings::call('kv', 'put', [
            'key' => $this->prefix . $key,
            'value' => serialize($value),
        ]);

        return true;
    }

    public function forget($key)
    {
        CfBindings::call('kv', 'delete', ['key' => $this->prefix . $key]);

        return true;
    }

    public function flush()
    {
        return false;
    }

    public function getPrefix()
    {
        return $this->prefix;
    }
}
