<?php

namespace WorkersPhp\Cloudflare\Tests;

use WorkersPhp\Cloudflare\Cache\DoStore;
use WorkersPhp\Cloudflare\Testing\FakeCloudflare;

class DoStoreTest extends TestCase
{
    private DoStore $store;

    protected function setUp(): void
    {
        parent::setUp();
        $this->store = new DoStore();
    }

    public function test_wire_tagging_matches_the_contract_fixtures(): void
    {
        $cases = json_decode(
            file_get_contents(__DIR__ . '/../../../contracts/bindings-cases.json'),
            true,
        )['docacheTagging'];

        foreach ($cases as $i => $case) {
            FakeCloudflare::reset();
            $this->store->put('key', $case['php'], 60);
            $stored = FakeCloudflare::$docache['key']['value'];

            if ($case['tag'] === 'n') {
                $this->assertSame($case['wire'], $stored, "case {$i}: numeric rides raw");
            } else {
                $this->assertArrayHasKey('s', $stored, "case {$i}: non-numeric is serialized");
                $this->assertArrayNotHasKey('n', $stored, "case {$i}");
                $this->assertSame($case['php'], unserialize($stored['s']), "case {$i}: round-trips");
            }

            $this->assertSame($case['php'], $this->store->get('key'), "case {$i}: decode round-trip");
        }
    }

    public function test_increment_is_delegated_and_numeric(): void
    {
        $this->store->put('n', 3, 60);
        $this->assertSame(4, $this->store->increment('n'));
        $this->assertSame(2, $this->store->decrement('n', 2));
        // Starting from nothing counts from zero, like the Durable Object.
        $this->assertSame(7, $this->store->increment('fresh', 7));
    }

    public function test_forever_stores_without_expiry(): void
    {
        $this->store->forever('key', 'value');
        $this->assertNull(FakeCloudflare::$docache['key']['expiresAt']);
    }

    public function test_flush_clears_the_store(): void
    {
        $this->store->put('a', 1, 60);
        $this->assertTrue($this->store->flush());
        $this->assertNull($this->store->get('a'));
    }
}
