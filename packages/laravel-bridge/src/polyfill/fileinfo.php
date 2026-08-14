<?php

/**
 * fileinfo polyfill for the wasm runtime (symfony/polyfill pattern): the PHP
 * build ships without ext-fileinfo — its magic database is megabytes — but
 * Flysystem's mime detection instantiates \finfo unconditionally. Images get
 * real content sniffing via getimagesize; everything else answers by
 * extension or a small magic-byte table.
 */

if (!defined('FILEINFO_NONE')) {
    define('FILEINFO_NONE', 0);
    define('FILEINFO_MIME_TYPE', 16);
    define('FILEINFO_MIME_ENCODING', 1040);
    define('FILEINFO_MIME', 1040 | 16);
}

if (!class_exists('finfo')) {
    class finfo
    {
        public function __construct(int $flags = FILEINFO_NONE, string $magic_database = '')
        {
        }

        public function file(string $filename, int $flags = FILEINFO_NONE): string|false
        {
            $info = @getimagesize($filename);
            if (is_array($info) && isset($info['mime'])) {
                return $info['mime'];
            }

            $sample = @file_get_contents($filename, false, null, 0, 64);
            if (is_string($sample) && $sample !== '') {
                $sniffed = $this->sniff($sample);
                if ($sniffed !== null) {
                    return $sniffed;
                }
            }

            $extension = strtolower(pathinfo($filename, PATHINFO_EXTENSION));
            if ($extension !== '' && class_exists(\Symfony\Component\Mime\MimeTypes::class)) {
                $mapped = \Symfony\Component\Mime\MimeTypes::getDefault()->getMimeTypes($extension)[0] ?? null;
                if ($mapped !== null) {
                    return $mapped;
                }
            }

            return 'application/octet-stream';
        }

        public function buffer(string $string, int $flags = FILEINFO_NONE): string|false
        {
            if (function_exists('getimagesizefromstring')) {
                $info = @getimagesizefromstring($string);
                if (is_array($info) && isset($info['mime'])) {
                    return $info['mime'];
                }
            }

            return $this->sniff(substr($string, 0, 64)) ?? 'application/octet-stream';
        }

        private function sniff(string $bytes): ?string
        {
            foreach ([
                "%PDF-" => 'application/pdf',
                "PK\x03\x04" => 'application/zip',
                "\x1f\x8b" => 'application/gzip',
                "GIF8" => 'image/gif',
                "\x89PNG" => 'image/png',
                "\xff\xd8\xff" => 'image/jpeg',
                "RIFF" => 'audio/x-riff',
                "<?xml" => 'application/xml',
            ] as $magic => $mime) {
                if (str_starts_with($bytes, $magic)) {
                    return $mime;
                }
            }

            return null;
        }
    }
}
