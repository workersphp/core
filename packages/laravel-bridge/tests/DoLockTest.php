<?php

namespace WorkersPhp\Cloudflare\Tests;

use WorkersPhp\Cloudflare\Cache\DoStore;

class DoLockTest extends TestCase
{
    public function test_contended_lock_admits_exactly_one_owner(): void
    {
        $store = new DoStore();

        $first = $store->lock('job', 30, 'owner-a');
        $second = $store->lock('job', 30, 'owner-b');

        $this->assertTrue($first->acquire());
        $this->assertFalse($second->acquire(), 'a different owner cannot steal a live lock');
        $this->assertTrue($first->acquire(), 're-acquisition by the holder is permitted');

        $this->assertFalse($second->release(), 'release by a non-owner is refused');
        $this->assertTrue($first->release());
        $this->assertTrue($second->acquire(), 'freed lock is available to the next contender');
    }

    public function test_force_release_clears_any_owner(): void
    {
        $store = new DoStore();
        $held = $store->lock('job', 30, 'owner-a');
        $held->acquire();

        $store->lock('job', 0, 'owner-b')->forceRelease();

        $this->assertTrue($store->lock('job', 30, 'owner-c')->acquire());
    }

    public function test_restore_lock_reports_the_current_owner(): void
    {
        $store = new DoStore();
        $store->lock('job', 30, 'owner-a')->acquire();

        $this->assertSame('owner-a', $store->restoreLock('job', 'owner-a')->owner());
    }
}
