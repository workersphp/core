<?php

namespace WorkersPhp\Cloudflare\Queue;

use Illuminate\Contracts\Queue\Queue as QueueContract;
use Illuminate\Queue\Queue;

/**
 * Queue driver over the outbox pattern: push() writes the standard Laravel
 * payload to an outbox directory during the request; the Workers runtime
 * flushes it to a Cloudflare Queue binding after the response is sent, and
 * the same Worker consumes batches by firing each payload in-process.
 * Application code stays on plain dispatch()/Bus::batch() semantics.
 *
 * pop() is intentionally null: consumption is push-based (the Worker's
 * queue() handler), never polled from PHP.
 */
class CloudflareQueue extends Queue implements QueueContract
{
    public function __construct(
        private readonly string $default = 'default',
        private readonly string $path = '/tmp/queue-outbox',
    ) {
    }

    public function size($queue = null)
    {
        // Depth lives in Cloudflare's queue, unreachable from PHP mid-request.
        return 0;
    }

    public function pendingSize($queue = null)
    {
        return 0;
    }

    public function delayedSize($queue = null)
    {
        return 0;
    }

    public function reservedSize($queue = null)
    {
        return 0;
    }

    public function creationTimeOfOldestPendingJob($queue = null)
    {
        return null;
    }

    public function push($job, $data = '', $queue = null)
    {
        return $this->enqueueUsing(
            $job,
            $this->createPayload($job, $queue ?: $this->default, $data),
            $queue,
            null,
            fn ($payload, $queue) => $this->pushRaw($payload, $queue),
        );
    }

    public function pushRaw($payload, $queue = null, array $options = [])
    {
        if (! is_dir($this->path)) {
            mkdir($this->path, 0777, true);
        }

        file_put_contents(
            $this->path . '/' . bin2hex(random_bytes(8)) . '.json',
            json_encode([
                'queue' => $queue ?: $this->default,
                'payload' => $payload,
                'delaySeconds' => $options['delay'] ?? 0,
            ], JSON_THROW_ON_ERROR),
        );

        return json_decode($payload, true)['uuid'] ?? null;
    }

    public function later($delay, $job, $data = '', $queue = null)
    {
        return $this->enqueueUsing(
            $job,
            $this->createPayload($job, $queue ?: $this->default, $data),
            $queue,
            $delay,
            fn ($payload, $queue, $delay) => $this->pushRaw($payload, $queue, [
                'delay' => $this->secondsUntil($delay),
            ]),
        );
    }

    public function pop($queue = null)
    {
        return null;
    }
}
