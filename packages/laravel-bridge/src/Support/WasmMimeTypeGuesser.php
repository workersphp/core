<?php

namespace WorkersPhp\Cloudflare\Support;

use Symfony\Component\Mime\MimeTypes;
use Symfony\Component\Mime\MimeTypeGuesserInterface;

/**
 * The wasm build ships without ext-fileinfo (its magic database is megabytes)
 * and the binary-`file` guesser needs exec — so Symfony has no supported MIME
 * guesser and every image/mimes validation rule fails. getimagesize() is real
 * content sniffing for images; everything else falls back to Symfony's own
 * extension map.
 */
class WasmMimeTypeGuesser implements MimeTypeGuesserInterface
{
    public function isGuesserSupported(): bool
    {
        return true;
    }

    public function guessMimeType(string $path): ?string
    {
        $info = @getimagesize($path);
        if (is_array($info) && isset($info['mime'])) {
            return $info['mime'];
        }

        $extension = strtolower(pathinfo($path, PATHINFO_EXTENSION));

        return $extension !== ''
            ? (MimeTypes::getDefault()->getMimeTypes($extension)[0] ?? null)
            : null;
    }
}
