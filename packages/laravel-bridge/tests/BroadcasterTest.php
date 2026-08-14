<?php

namespace WorkersPhp\Cloudflare\Tests;

use Illuminate\Http\Request;
use WorkersPhp\Cloudflare\Broadcasting\CloudflareBroadcaster;

class BroadcasterTest extends TestCase
{
    private string $outbox;

    private function broadcaster(string $secret = 'test-secret'): CloudflareBroadcaster
    {
        $this->outbox = sys_get_temp_dir() . '/broadcast-outbox-' . bin2hex(random_bytes(4));

        return new CloudflareBroadcaster($secret, $this->outbox);
    }

    public function test_private_channel_auth_is_pusher_compatible(): void
    {
        $broadcaster = $this->broadcaster('the-app-key');
        $request = Request::create('/broadcasting/auth', 'POST', [
            'socket_id' => '123.456',
            'channel_name' => 'private-chirps',
        ]);

        $response = $broadcaster->validAuthenticationResponse($request, true);

        $this->assertSame(
            'app:' . hash_hmac('sha256', '123.456:private-chirps', 'the-app-key'),
            $response['auth'],
        );
        $this->assertArrayNotHasKey('channel_data', $response);
    }

    public function test_broadcast_writes_the_contracted_outbox_shape(): void
    {
        $broadcaster = $this->broadcaster();
        $broadcaster->broadcast(
            ['demo', 'private-chirps'],
            'chirp.created',
            ['message' => 'hello', 'socket' => 'skip-me-socket'],
        );

        $files = glob($this->outbox . '/*.json');
        $this->assertCount(1, $files);
        $entry = json_decode(file_get_contents($files[0]), true);

        $contract = json_decode(
            file_get_contents(__DIR__ . '/../../../contracts/bindings-cases.json'),
            true,
        )['outboxShapes']['broadcast']['requiredKeys'];
        foreach ($contract as $key) {
            $this->assertArrayHasKey($key, $entry);
        }

        $this->assertSame(['demo', 'private-chirps'], $entry['channels']);
        $this->assertSame('chirp.created', $entry['event']);
        $this->assertSame(['message' => 'hello'], $entry['data'], 'socket is pulled out of the payload');
        $this->assertSame('skip-me-socket', $entry['socket']);
    }

    protected function tearDown(): void
    {
        foreach (glob(($this->outbox ?? '/nonexistent') . '/*.json') ?: [] as $file) {
            unlink($file);
        }
        @rmdir($this->outbox ?? '/nonexistent');
        parent::tearDown();
    }
}
