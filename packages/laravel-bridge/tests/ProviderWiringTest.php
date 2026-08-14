<?php

namespace WorkersPhp\Cloudflare\Tests;

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Storage;
use WorkersPhp\Cloudflare\Broadcasting\CloudflareBroadcaster;
use WorkersPhp\Cloudflare\Cache\DoStore;
use WorkersPhp\Cloudflare\Cache\KvStore;
use WorkersPhp\Cloudflare\Mail\OutboxTransport;
use WorkersPhp\Cloudflare\Queue\CloudflareQueue;
use WorkersPhp\Cloudflare\Storage\R2Adapter;

class ProviderWiringTest extends TestCase
{
    protected function defineEnvironment($app)
    {
        // The broadcaster signs with the app key; production always has one.
        $app['config']->set('app.key', 'base64:' . base64_encode(random_bytes(32)));
        // A user-defined store the provider must NOT overwrite.
        $app['config']->set('cache.stores.kv', ['driver' => 'kv', 'custom_marker' => true]);
    }

    public function test_kv_cache_store_resolves(): void
    {
        $this->assertInstanceOf(KvStore::class, Cache::store('kv')->getStore());
    }

    public function test_do_cache_store_resolves_with_lock_connection(): void
    {
        $this->assertInstanceOf(DoStore::class, Cache::store('do')->getStore());
        $this->assertSame('do', config('cache.stores.do.lock_connection'));
    }

    public function test_user_defined_store_config_wins(): void
    {
        $this->assertTrue(config('cache.stores.kv.custom_marker'));
    }

    public function test_r2_disk_uses_the_adapter_when_bridge_is_available(): void
    {
        // The test bootstrap defines cf_bindings_call, so the real adapter wins
        // over the local staging fallback.
        $this->assertInstanceOf(R2Adapter::class, Storage::disk('r2')->getAdapter());
        $this->assertSame('/storage', config('filesystems.disks.r2.url'));
    }

    public function test_cloudflare_mailer_uses_the_outbox_transport(): void
    {
        $transport = $this->app['mail.manager']->mailer('cloudflare')->getSymfonyTransport();
        $this->assertInstanceOf(OutboxTransport::class, $transport);
    }

    public function test_cloudflare_queue_connection_resolves(): void
    {
        $this->assertInstanceOf(CloudflareQueue::class, Queue::connection('cloudflare'));
    }

    public function test_cloudflare_broadcaster_resolves(): void
    {
        $manager = $this->app->make(\Illuminate\Contracts\Broadcasting\Factory::class);
        $this->assertInstanceOf(CloudflareBroadcaster::class, $manager->connection('cloudflare'));
    }

    public function test_view_caching_is_made_portable(): void
    {
        $this->assertFalse(config('view.check_cache_timestamps'));
        $this->assertTrue(config('view.relative_hash'));
    }

    public function test_cfd1_stays_inert_without_the_pdo_driver(): void
    {
        // Host PHP has no pdo_cfd1, so the D1 wiring must not have registered.
        $this->assertNull(config('database.connections.cfd1'));
    }
}
