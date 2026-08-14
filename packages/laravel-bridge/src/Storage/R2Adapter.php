<?php

namespace WorkersPhp\Cloudflare\Storage;

use League\Flysystem\Config;
use League\Flysystem\DirectoryAttributes;
use League\Flysystem\FileAttributes;
use League\Flysystem\FilesystemAdapter;
use League\Flysystem\UnableToReadFile;
use League\Flysystem\UnableToRetrieveMetadata;
use WorkersPhp\Cloudflare\Support\CfBindings;

/**
 * Flysystem v3 adapter over the R2 binding via the cfbindings bridge. Bodies
 * cross the bridge base64-encoded, so this is for app-sized objects (uploads,
 * exports), not multi-hundred-MB streams. R2 is read-after-write consistent:
 * Storage::put() then Storage::get() works within one request. Directories
 * are R2's usual fiction — prefixes exist while objects carry them.
 */
class R2Adapter implements FilesystemAdapter
{
    public function __construct(private readonly string $urlPrefix = '/storage')
    {
    }

    /**
     * Laravel duck-types getUrl on custom adapters — config['url'] is only
     * consulted for the built-in local/FTP drivers.
     */
    public function getUrl(string $path): string
    {
        return rtrim($this->urlPrefix, '/') . '/' . ltrim($path, '/');
    }

    public function fileExists(string $path): bool
    {
        return CfBindings::call('r2', 'head', ['key' => $path]) !== null;
    }

    public function directoryExists(string $path): bool
    {
        $listed = CfBindings::call('r2', 'list', ['prefix' => rtrim($path, '/') . '/']);

        return $listed['objects'] !== [];
    }

    public function write(string $path, string $contents, Config $config): void
    {
        CfBindings::call('r2', 'put', [
            'key' => $path,
            'body' => base64_encode($contents),
            'contentType' => $config->get('mime_type'),
        ]);
    }

    public function writeStream(string $path, $contents, Config $config): void
    {
        $this->write($path, (string) stream_get_contents($contents), $config);
    }

    public function read(string $path): string
    {
        $object = CfBindings::call('r2', 'get', ['key' => $path]);
        if ($object === null) {
            throw UnableToReadFile::fromLocation($path, 'object does not exist');
        }

        return base64_decode($object['body']);
    }

    public function readStream(string $path)
    {
        $stream = fopen('php://temp', 'r+b');
        fwrite($stream, $this->read($path));
        rewind($stream);

        return $stream;
    }

    public function delete(string $path): void
    {
        CfBindings::call('r2', 'delete', ['key' => $path]);
    }

    public function deleteDirectory(string $path): void
    {
        $prefix = rtrim($path, '/') . '/';
        do {
            $listed = CfBindings::call('r2', 'list', ['prefix' => $prefix]);
            $keys = array_column($listed['objects'], 'key');
            if ($keys !== []) {
                CfBindings::call('r2', 'delete', ['keys' => $keys]);
            }
        } while (($listed['truncated'] ?? false) && $keys !== []);
    }

    public function createDirectory(string $path, Config $config): void
    {
        // Directories are prefixes; nothing to create.
    }

    public function setVisibility(string $path, string $visibility): void
    {
        // Visibility is decided by the Worker's /storage route, not per object.
    }

    public function visibility(string $path): FileAttributes
    {
        return new FileAttributes($path, null, 'public');
    }

    public function mimeType(string $path): FileAttributes
    {
        $head = CfBindings::call('r2', 'head', ['key' => $path]);
        if ($head === null || ($head['contentType'] ?? null) === null) {
            throw UnableToRetrieveMetadata::mimeType($path);
        }

        return new FileAttributes($path, null, null, null, $head['contentType']);
    }

    public function lastModified(string $path): FileAttributes
    {
        $head = CfBindings::call('r2', 'head', ['key' => $path]);
        if ($head === null || ($head['uploaded'] ?? null) === null) {
            throw UnableToRetrieveMetadata::lastModified($path);
        }

        return new FileAttributes($path, null, null, strtotime($head['uploaded']));
    }

    public function fileSize(string $path): FileAttributes
    {
        $head = CfBindings::call('r2', 'head', ['key' => $path]);
        if ($head === null) {
            throw UnableToRetrieveMetadata::fileSize($path);
        }

        return new FileAttributes($path, $head['size']);
    }

    public function listContents(string $path, bool $deep): iterable
    {
        $prefix = $path === '' ? '' : rtrim($path, '/') . '/';
        $cursor = null;
        do {
            $listed = CfBindings::call('r2', 'list', array_filter([
                'prefix' => $prefix,
                'cursor' => $cursor,
                'delimiter' => $deep ? null : '/',
            ], fn ($v) => $v !== null && $v !== ''));

            foreach ($listed['delimitedPrefixes'] ?? [] as $dir) {
                yield new DirectoryAttributes(rtrim($dir, '/'));
            }
            foreach ($listed['objects'] as $object) {
                yield new FileAttributes(
                    $object['key'],
                    $object['size'],
                    null,
                    isset($object['uploaded']) ? strtotime($object['uploaded']) : null,
                );
            }
            $cursor = $listed['cursor'] ?? null;
        } while ($cursor !== null);
    }

    public function move(string $source, string $destination, Config $config): void
    {
        $this->copy($source, $destination, $config);
        $this->delete($source);
    }

    public function copy(string $source, string $destination, Config $config): void
    {
        $object = CfBindings::call('r2', 'get', ['key' => $source]);
        if ($object === null) {
            throw UnableToReadFile::fromLocation($source, 'object does not exist');
        }
        CfBindings::call('r2', 'put', [
            'key' => $destination,
            'body' => $object['body'],
            'contentType' => $object['contentType'],
        ]);
    }
}
