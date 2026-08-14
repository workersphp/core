<?php

namespace WorkersPhp\Cloudflare\Mail;

use Symfony\Component\Mailer\SentMessage;
use Symfony\Component\Mailer\Transport\AbstractTransport;

/**
 * Writes outgoing mail to an outbox directory instead of a socket. The Workers
 * runtime reads the outbox after each request and dispatches the messages
 * through its configured channel (Cloudflare Email Sending binding or an HTTP
 * mail API). Workers cannot speak SMTP — port 25 is blocked platform-wide — so
 * transactional mail always leaves through HTTP, and this transport is the
 * seam that keeps application code on plain Mail::to(...)->send(...).
 */
class OutboxTransport extends AbstractTransport
{
    public function __construct(private readonly string $path = '/tmp/outbox')
    {
        parent::__construct();
    }

    protected function doSend(SentMessage $message): void
    {
        if (! is_dir($this->path)) {
            mkdir($this->path, 0777, true);
        }

        $envelope = $message->getEnvelope();

        file_put_contents(
            $this->path . '/' . bin2hex(random_bytes(8)) . '.json',
            json_encode([
                // Bare addresses: these are envelope (routing) fields — display
                // names live in the MIME headers, and Cloudflare's EmailMessage
                // expects plain addresses here.
                'from' => $envelope->getSender()->getAddress(),
                'to' => array_map(fn ($address) => $address->getAddress(), $envelope->getRecipients()),
                'mime' => $message->toString(),
            ], JSON_THROW_ON_ERROR),
        );
    }

    public function __toString(): string
    {
        return 'cloudflare';
    }
}
