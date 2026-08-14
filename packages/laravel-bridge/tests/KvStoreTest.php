<?php

namespace WorkersPhp\Cloudflare\Tests;

use WorkersPhp\Cloudflare\Cache\KvStore;
use WorkersPhp\Cloudflare\Testing\FakeCloudflare;

class KvStoreTest extends TestCase
{
    private KvStore $store;

    protected function setUp(): void
    {
        parent::setUp();
        $this->store = new KvStore('prefix:');
    }

    public function test_round_trips_serialized_values(): void
    {
        $this->store->put('key', ['nested' => ['a', 1, 2.5]], 120);
        $this->assertSame(['nested' => ['a', 1, 2.5]], $this->store->get('key'));
    }

    public function test_applies_its_prefix(): void
    {
        $this->store->put('key', 'v', 60);
        $this->assertArrayHasKey('prefix:key', FakeCloudflare::$kv);
    }

    public function test_ttl_is_clamped_like_workers_kv(): void
    {
        $cases = json_decode(
            file_get_contents(__DIR__ . '/../../../contracts/bindings-cases.json'),
            true,
        )['kvTtlClamp'];

        foreach ($cases as $case) {
            FakeCloudflare::reset();
            $this->store->put('key', 'v', $case['requested']);
            $this->assertSame(
                $case['stored'],
                FakeCloudflare::$kv['prefix:key']['ttl'],
                "requested ttl {$case['requested']}",
            );
        }
    }

    public function test_forever_and_forget(): void
    {
        $this->store->forever('key', 'v');
        $this->assertNull(FakeCloudflare::$kv['prefix:key']['ttl']);
        $this->store->forget('key');
        $this->assertNull($this->store->get('key'));
    }

    public function test_touch_on_a_missing_key_reports_failure(): void
    {
        $this->assertFalse($this->store->touch('missing', 60));
    }

    public function test_increment_is_read_modify_write(): void
    {
        $this->assertSame(3, $this->store->increment('n', 3));
        $this->assertSame(5, $this->store->increment('n', 2));
        $this->assertSame(4, $this->store->decrement('n'));
    }

    public function test_flush_is_refused(): void
    {
        $this->assertFalse($this->store->flush());
    }
}
