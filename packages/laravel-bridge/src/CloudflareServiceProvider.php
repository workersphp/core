<?php

namespace WorkersPhp\Cloudflare;

use Illuminate\Database\Connection;
use Illuminate\Database\SQLiteConnection;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\ServiceProvider;
use PDO;
use WorkersPhp\Cloudflare\Mail\OutboxTransport;

/**
 * Registers Cloudflare-backed drivers under Laravel's normal extension points.
 *
 * Nothing here is forced on the application: each driver only takes effect when
 * selected through standard configuration (DB_CONNECTION=cfd1, MAIL_MAILER=cloudflare,
 * ...). Every stock driver — S3, Redis, SMTP, MySQL over Hyperdrive — remains a
 * first-class choice.
 */
class CloudflareServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->configureViewCaching();
        $this->registerD1Driver();
    }

    /**
     * Make compiled views portable: skip mtime comparisons (compiled artifacts
     * are baked at pack time and shipped read-only) and hash compiled filenames
     * from base-path-relative source paths so bake and runtime agree regardless
     * of absolute location. Laravel 12+.
     */
    private function configureViewCaching(): void
    {
        config([
            'view.check_cache_timestamps' => false,
            'view.relative_hash' => true,
        ]);
    }

    public function boot(): void
    {
        $this->registerMailTransport();
        $this->registerQueueDriver();
        $this->registerBroadcastDriver();
        $this->registerR2Disk();
        $this->registerKvCache();
        $this->registerMimeGuesser();
    }

    /**
     * Registered guessers are consulted last-registered-first, so this becomes
     * the primary guesser ahead of the unsupported fileinfo/binary ones.
     */
    private function registerMimeGuesser(): void
    {
        \Symfony\Component\Mime\MimeTypes::getDefault()
            ->registerGuesser(new Support\WasmMimeTypeGuesser());
    }

    /**
     * R2-backed public storage. With the cfbindings extension compiled in,
     * the disk is a real Flysystem adapter over the R2 binding — put, get,
     * exists, delete and list all work synchronously from PHP. Without it,
     * writes stage on the local (wasm) filesystem and the Worker sweeps them
     * into the bucket after the request (store-then-serve-by-URL only).
     * Either way the Worker serves /storage/<path> straight from R2.
     */
    private function registerR2Disk(): void
    {
        \Illuminate\Support\Facades\Storage::extend('r2', function ($app, array $config) {
            $adapter = Support\CfBindings::available()
                ? new Storage\R2Adapter($config['url'] ?? '/storage')
                : new \League\Flysystem\Local\LocalFilesystemAdapter($config['root'] ?? '/tmp/r2-staging');

            return new \Illuminate\Filesystem\FilesystemAdapter(
                new \League\Flysystem\Filesystem($adapter, $config),
                $adapter,
                $config,
            );
        });

        if (config('filesystems.disks.r2') === null) {
            config([
                'filesystems.disks.r2' => [
                    'driver' => 'r2',
                    'root' => '/tmp/r2-staging',
                    // Relative: correct behind any host, and immune to the
                    // baked config cache freezing a bake-time app.url.
                    'url' => '/storage',
                    'visibility' => 'public',
                    'throw' => false,
                ],
            ]);
        }
    }

    /**
     * Workers KV as a cache store (requires the cfbindings extension).
     * Select with CACHE_STORE=kv. KV is eventually consistent and rate-limits
     * writes per key — right for read-mostly cache, wrong for locks/counters
     * (those want the database or a Durable Object).
     */
    private function registerKvCache(): void
    {
        \Illuminate\Support\Facades\Cache::extend('kv', function ($app, array $config) {
            return $app['cache']->repository(
                new Cache\KvStore($config['prefix'] ?? config('cache.prefix', '')),
            );
        });

        if (config('cache.stores.kv') === null) {
            config(['cache.stores.kv' => ['driver' => 'kv']]);
        }

        // The coordination cache: Durable Object shards with atomic
        // increment and real Cache::lock support. Rate limiters and locks
        // belong here; read-mostly cache belongs on 'kv'.
        \Illuminate\Support\Facades\Cache::extend('do', function ($app, array $config) {
            return $app['cache']->repository(
                new Cache\DoStore($config['prefix'] ?? config('cache.prefix', '')),
            );
        });

        if (config('cache.stores.do') === null) {
            config(['cache.stores.do' => ['driver' => 'do', 'lock_connection' => 'do']]);
        }
    }

    /**
     * D1 as a database driver. D1 speaks SQLite, so the SQLite connection and
     * grammar apply; the PDO comes from the runtime's pdo_cfd1 extension, whose
     * DSN names the D1 binding exposed by the Worker ('cfd1:DB').
     */
    private function registerD1Driver(): void
    {
        // Only meaningful inside the Workers runtime; harmless elsewhere.
        if (! in_array('cfd1', PDO::getAvailableDrivers(), true)) {
            return;
        }

        Connection::resolverFor('cfd1', function ($connection, $database, $prefix, $config) {
            // D1 rejects PRAGMA through the driver; never let the SQLite
            // connection issue one at connect time.
            unset($config['foreign_key_constraints']);

            return new SQLiteConnection(new PDO('cfd1:' . $database), $database, $prefix, $config);
        });

        // A sensible default connection entry, only if the app hasn't defined one.
        if (config('database.connections.cfd1') === null) {
            config([
                'database.connections.cfd1' => [
                    'driver' => 'cfd1',
                    'database' => env('D1_BINDING', 'DB'),
                    'prefix' => '',
                ],
            ]);
        }
    }

    /**
     * Mail via the outbox pattern: messages are written to an outbox directory
     * in the runtime filesystem during the request; the Worker flushes them
     * after the response through Cloudflare Email Sending (or any HTTP mail
     * API the Worker is configured with). Select with MAIL_MAILER=cloudflare.
     */
    private function registerMailTransport(): void
    {
        Mail::extend('cloudflare', function (array $config = []) {
            return new OutboxTransport($config['path'] ?? '/tmp/outbox');
        });

        if (config('mail.mailers.cloudflare') === null) {
            config(['mail.mailers.cloudflare' => ['transport' => 'cloudflare']]);
        }
    }

    /**
     * Broadcasting via the Durable Object WebSocket hub: publishes ride the
     * outbox (flushed into the hub's RPC after the response); channel auth is
     * Pusher-protocol-compatible so Laravel Echo works unmodified. Select with
     * BROADCAST_CONNECTION=cloudflare.
     */
    private function registerBroadcastDriver(): void
    {
        $this->app->make(\Illuminate\Contracts\Broadcasting\Factory::class)
            ->extend('cloudflare', function ($app, array $config) {
                return new Broadcasting\CloudflareBroadcaster(
                    $app['config']->get('app.key'),
                    $config['path'] ?? '/tmp/broadcast-outbox',
                );
            });

        if (config('broadcasting.connections.cloudflare') === null) {
            config([
                'broadcasting.connections.cloudflare' => ['driver' => 'cloudflare'],
            ]);
        }
    }

    /**
     * Queues via the outbox pattern: push writes to an outbox directory the
     * Worker flushes into a Cloudflare Queue after the response; the Worker's
     * queue handler runs delivered payloads in-process. Select with
     * QUEUE_CONNECTION=cloudflare.
     */
    private function registerQueueDriver(): void
    {
        $this->app['queue']->extend('cloudflare', fn () => new Queue\CloudflareConnector());

        if (config('queue.connections.cloudflare') === null) {
            config([
                'queue.connections.cloudflare' => [
                    'driver' => 'cloudflare',
                    'queue' => 'default',
                ],
            ]);
        }
    }
}
