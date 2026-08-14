<?php

namespace WorkersPhp\Cloudflare\Tests;

use Illuminate\Support\Facades\Queue;
use WorkersPhp\Cloudflare\Tests\Fixtures\TestJob;

class QueueOutboxTest extends TestCase
{
    private string $outbox;

    protected function defineEnvironment($app)
    {
        $this->outbox = sys_get_temp_dir() . '/queue-outbox-' . bin2hex(random_bytes(4));
        $app['config']->set('queue.default', 'cloudflare');
        $app['config']->set('queue.connections.cloudflare', [
            'driver' => 'cloudflare',
            'queue' => 'default',
            'path' => $this->outbox,
        ]);
    }

    private function outboxFiles(): array
    {
        return glob($this->outbox . '/*.json') ?: [];
    }

    public function test_push_writes_the_contracted_outbox_shape(): void
    {
        TestJob::dispatch('marker-1');

        $files = $this->outboxFiles();
        $this->assertCount(1, $files);

        $entry = json_decode(file_get_contents($files[0]), true);
        $contract = json_decode(
            file_get_contents(__DIR__ . '/../../../contracts/bindings-cases.json'),
            true,
        )['outboxShapes']['queue']['requiredKeys'];
        foreach ($contract as $key) {
            $this->assertArrayHasKey($key, $entry);
        }

        $this->assertSame('default', $entry['queue']);
        $this->assertSame(0, $entry['delaySeconds']);

        $payload = json_decode($entry['payload'], true);
        $this->assertSame(TestJob::class, $payload['displayName']);
        $this->assertNotEmpty($payload['uuid']);
    }

    public function test_later_records_the_delay(): void
    {
        TestJob::dispatch('marker-2')->delay(45);

        $entry = json_decode(file_get_contents($this->outboxFiles()[0]), true);
        $this->assertSame(45, $entry['delaySeconds']);
    }

    public function test_pop_is_push_based_and_returns_nothing(): void
    {
        $this->assertNull(Queue::connection('cloudflare')->pop());
    }

    protected function tearDown(): void
    {
        foreach ($this->outboxFiles() as $file) {
            unlink($file);
        }
        @rmdir($this->outbox);
        parent::tearDown();
    }
}
