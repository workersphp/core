<?php

namespace WorkersPhp\Cloudflare\Tests;

use WorkersPhp\Cloudflare\CloudflareServiceProvider;
use WorkersPhp\Cloudflare\Testing\FakeCloudflare;

abstract class TestCase extends \Orchestra\Testbench\TestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        FakeCloudflare::reset();
    }

    protected function getPackageProviders($app)
    {
        return [CloudflareServiceProvider::class];
    }
}
