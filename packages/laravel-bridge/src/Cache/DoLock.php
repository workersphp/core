<?php

namespace WorkersPhp\Cloudflare\Cache;

use Illuminate\Cache\Lock;
use WorkersPhp\Cloudflare\Support\CfBindings;

/**
 * A real distributed lock: acquisition is a single serialized operation
 * inside one Durable Object, so two isolates racing for the same name cannot
 * both win. TTL guards against a crashed holder wedging the lock forever.
 */
class DoLock extends Lock
{
    public function acquire()
    {
        return (bool) CfBindings::call('docache', 'lock', [
            'key' => $this->name,
            'owner' => $this->owner,
            'ttl' => (int) $this->seconds,
        ]);
    }

    public function release()
    {
        return (bool) CfBindings::call('docache', 'unlock', [
            'key' => $this->name,
            'owner' => $this->owner,
        ]);
    }

    public function forceRelease()
    {
        CfBindings::call('docache', 'unlock', [
            'key' => $this->name,
            'owner' => null,
        ]);
    }

    protected function getCurrentOwner()
    {
        return CfBindings::call('docache', 'lockOwner', ['key' => $this->name]);
    }
}
