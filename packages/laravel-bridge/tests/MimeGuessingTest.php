<?php

namespace WorkersPhp\Cloudflare\Tests;

use WorkersPhp\Cloudflare\Support\WasmMimeTypeGuesser;

class MimeGuessingTest extends TestCase
{
    private const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    public function test_images_are_sniffed_by_content(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'probe') . '.bin'; // extension lies on purpose
        file_put_contents($path, base64_decode(self::PNG_1X1));

        $this->assertSame('image/png', (new WasmMimeTypeGuesser())->guessMimeType($path));
        unlink($path);
    }

    public function test_non_images_fall_back_to_the_extension_map(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'probe') . '.css';
        file_put_contents($path, 'body { color: red }');

        $this->assertSame('text/css', (new WasmMimeTypeGuesser())->guessMimeType($path));
        unlink($path);
    }

    public function test_the_polyfill_magic_table_recognizes_common_types(): void
    {
        if (extension_loaded('fileinfo')) {
            // Host PHP ships fileinfo, so the polyfill class never defines
            // itself here; its magic table is exercised in the wasm runtime.
            $this->markTestSkipped('host has ext-fileinfo; polyfill is inert');
        }

        $finfo = new \finfo(FILEINFO_MIME_TYPE);
        $this->assertSame('image/png', $finfo->buffer(base64_decode(self::PNG_1X1)));
        $this->assertSame('application/pdf', $finfo->buffer('%PDF-1.7 fake'));
    }
}
