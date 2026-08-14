<?php

namespace WorkersPhp\Cloudflare\Tests;

use League\Flysystem\Config;
use League\Flysystem\DirectoryAttributes;
use League\Flysystem\FileAttributes;
use League\Flysystem\UnableToReadFile;
use WorkersPhp\Cloudflare\Storage\R2Adapter;
use WorkersPhp\Cloudflare\Testing\FakeCloudflare;

class R2AdapterTest extends TestCase
{
    private R2Adapter $adapter;

    protected function setUp(): void
    {
        parent::setUp();
        $this->adapter = new R2Adapter('/storage');
    }

    public function test_write_read_round_trip_survives_binary(): void
    {
        $binary = random_bytes(256);
        $this->adapter->write('a/b.bin', $binary, new Config(['mime_type' => 'application/octet-stream']));

        $this->assertSame($binary, $this->adapter->read('a/b.bin'));
        $this->assertSame(
            base64_encode($binary),
            FakeCloudflare::$r2['a/b.bin']['body'],
            'bodies cross the bridge base64-encoded',
        );
    }

    public function test_reading_a_missing_object_throws(): void
    {
        $this->expectException(UnableToReadFile::class);
        $this->adapter->read('missing.txt');
    }

    public function test_existence_size_and_mime(): void
    {
        $this->adapter->write('doc.pdf', '%PDF-fake', new Config(['mime_type' => 'application/pdf']));

        $this->assertTrue($this->adapter->fileExists('doc.pdf'));
        $this->assertFalse($this->adapter->fileExists('nope.pdf'));
        $this->assertSame(9, $this->adapter->fileSize('doc.pdf')->fileSize());
        $this->assertSame('application/pdf', $this->adapter->mimeType('doc.pdf')->mimeType());
    }

    public function test_get_url_joins_the_public_prefix(): void
    {
        $this->assertSame('/storage/chirp-photos/x.png', $this->adapter->getUrl('chirp-photos/x.png'));
        $this->assertSame('/storage/x.png', $this->adapter->getUrl('/x.png'));
    }

    public function test_shallow_listing_yields_directories_and_files(): void
    {
        $config = new Config();
        $this->adapter->write('root.txt', 'r', $config);
        $this->adapter->write('sub/one.txt', '1', $config);
        $this->adapter->write('sub/two.txt', '2', $config);

        $listed = iterator_to_array($this->adapter->listContents('', false));

        $dirs = array_filter($listed, fn ($item) => $item instanceof DirectoryAttributes);
        $files = array_filter($listed, fn ($item) => $item instanceof FileAttributes);
        $this->assertCount(1, $dirs);
        $this->assertSame('sub', array_values($dirs)[0]->path());
        $this->assertCount(1, $files);
    }

    public function test_delete_directory_removes_the_prefix(): void
    {
        $config = new Config();
        $this->adapter->write('gone/a.txt', 'a', $config);
        $this->adapter->write('gone/b.txt', 'b', $config);
        $this->adapter->write('kept.txt', 'k', $config);

        $this->adapter->deleteDirectory('gone');

        $this->assertFalse($this->adapter->fileExists('gone/a.txt'));
        $this->assertFalse($this->adapter->fileExists('gone/b.txt'));
        $this->assertTrue($this->adapter->fileExists('kept.txt'));
    }

    public function test_move_copies_then_deletes_the_source(): void
    {
        $this->adapter->write('from.txt', 'payload', new Config(['mime_type' => 'text/plain']));
        $this->adapter->move('from.txt', 'to.txt', new Config());

        $this->assertFalse($this->adapter->fileExists('from.txt'));
        $this->assertSame('payload', $this->adapter->read('to.txt'));
        $this->assertSame('text/plain', $this->adapter->mimeType('to.txt')->mimeType());
    }
}
