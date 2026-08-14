<?php

namespace WorkersPhp\Cloudflare\Broadcasting;

use Illuminate\Broadcasting\Broadcasters\Broadcaster;
use Illuminate\Broadcasting\Broadcasters\UsePusherChannelConventions;
use Illuminate\Support\Arr;
use Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException;

/**
 * Broadcasting over the Durable Object hub. Publishing rides the outbox
 * pattern (the Worker flushes /tmp/broadcast-outbox into the hub's RPC after
 * the response); channel authorization produces Pusher-protocol signatures so
 * Laravel Echo's stock /broadcasting/auth flow works unmodified. The signing
 * secret is the app key — already shared between PHP and the Worker.
 */
class CloudflareBroadcaster extends Broadcaster
{
    use UsePusherChannelConventions;

    public function __construct(
        private readonly string $secret,
        private readonly string $path = '/tmp/broadcast-outbox',
    ) {
    }

    public function auth($request)
    {
        $channelName = $this->normalizeChannelName($request->channel_name);

        if (empty($request->channel_name)
            || ($this->isGuardedChannel($request->channel_name) && ! $this->retrieveUser($request, $channelName))) {
            throw new AccessDeniedHttpException();
        }

        return parent::verifyUserCanAccessChannel($request, $channelName);
    }

    public function validAuthenticationResponse($request, $result)
    {
        $socketId = $request->socket_id;
        $channel = $request->channel_name;

        if (str_starts_with($channel, 'presence-')) {
            $user = $this->retrieveUser($request, $this->normalizeChannelName($channel));
            $channelData = json_encode([
                'user_id' => (string) $user->getAuthIdentifier(),
                'user_info' => $result === true ? [] : $result,
            ], JSON_THROW_ON_ERROR);

            return [
                'auth' => 'app:' . hash_hmac('sha256', "{$socketId}:{$channel}:{$channelData}", $this->secret),
                'channel_data' => $channelData,
            ];
        }

        return [
            'auth' => 'app:' . hash_hmac('sha256', "{$socketId}:{$channel}", $this->secret),
        ];
    }

    public function broadcast(array $channels, $event, array $payload = [])
    {
        if (! is_dir($this->path)) {
            mkdir($this->path, 0777, true);
        }

        $socket = Arr::pull($payload, 'socket');

        file_put_contents(
            $this->path . '/' . bin2hex(random_bytes(8)) . '.json',
            json_encode([
                'channels' => $this->formatChannels($channels),
                'event' => $event,
                'data' => $payload,
                'socket' => $socket,
            ], JSON_THROW_ON_ERROR),
        );
    }
}
