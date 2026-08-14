<?php

namespace WorkersPhp\Cloudflare\Queue;

use Illuminate\Queue\Connectors\ConnectorInterface;

class CloudflareConnector implements ConnectorInterface
{
    public function connect(array $config)
    {
        return new CloudflareQueue(
            $config['queue'] ?? 'default',
            $config['path'] ?? '/tmp/queue-outbox',
        );
    }
}
