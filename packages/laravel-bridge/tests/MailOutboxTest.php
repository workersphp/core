<?php

namespace WorkersPhp\Cloudflare\Tests;

use Illuminate\Support\Facades\Mail;

class MailOutboxTest extends TestCase
{
    private string $outbox;

    protected function defineEnvironment($app)
    {
        $this->outbox = sys_get_temp_dir() . '/mail-outbox-' . bin2hex(random_bytes(4));
        $app['config']->set('mail.default', 'cloudflare');
        $app['config']->set('mail.from', ['address' => 'sender@example.test', 'name' => 'Sender']);
        $app['config']->set('mail.mailers.cloudflare', [
            'transport' => 'cloudflare',
            'path' => $this->outbox,
        ]);
    }

    public function test_send_writes_envelope_and_mime_to_the_outbox(): void
    {
        Mail::raw('The body of the message.', function ($message) {
            $message->to('one@example.test')->cc('two@example.test')->subject('Probe');
        });

        $files = glob($this->outbox . '/*.json');
        $this->assertCount(1, $files);

        $entry = json_decode(file_get_contents($files[0]), true);
        $this->assertSame('sender@example.test', $entry['from']);
        $this->assertSame(['one@example.test', 'two@example.test'], $entry['to']);
        $this->assertStringContainsString('Subject: Probe', $entry['mime']);
        $this->assertStringContainsString('The body of the message.', $entry['mime']);
    }

    protected function tearDown(): void
    {
        foreach (glob($this->outbox . '/*.json') ?: [] as $file) {
            unlink($file);
        }
        @rmdir($this->outbox);
        parent::tearDown();
    }
}
