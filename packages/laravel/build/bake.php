<?php

/**
 * Pack-time artifact bake. Runs NATIVELY (Docker php-cli) with the app mounted
 * at /app — the same absolute path the wasm runtime uses, which Livewire's
 * generated classes and OPcache cache keys both embed.
 *
 * Strategy: compile by replaying real requests through the HTTP kernel — the
 * same code paths the runtime takes — so Blade, Flux, Volt and Livewire all
 * produce their artifacts exactly as production would, once, here.
 */

error_reporting(E_ALL & ~E_DEPRECATED);
chdir('/app');

// Bake against a production-shaped .env (dummy APP_KEY — runtime injects the
// real one; sqlite so the replay has a working database — runtime overrides
// database.default). The app's own .env is preserved and restored.
$originalEnv = is_file('/app/.env') ? file_get_contents('/app/.env') : null;
register_shutdown_function(function () use ($originalEnv) {
    if ($originalEnv === null) {
        @unlink('/app/.env');
    } else {
        file_put_contents('/app/.env', $originalEnv);
    }
});
file_put_contents('/app/.env', implode("\n", [
    'APP_ENV=production',
    'APP_KEY=base64:' . base64_encode(random_bytes(32)), // dummy; runtime overrides
    'APP_DEBUG=false',
    'APP_TIMEZONE=UTC',
    'LOG_CHANNEL=stderr',
    'LOG_LEVEL=debug',
    'SESSION_DRIVER=cookie',
    'CACHE_STORE=array',
    'QUEUE_CONNECTION=sync',
    'BROADCAST_CONNECTION=log',
    'FILESYSTEM_DISK=local',
    'DB_CONNECTION=sqlite',
    'DB_DATABASE=/app/database/bake.sqlite',
    '',
]));

// Blade + namespaced (Flux) views first — view:cache clears the compiled dir,
// including Livewire/Volt subdirectories, so it must run before the replay.
passthru('php artisan view:cache', $rc);
if ($rc !== 0) {
    fwrite(STDERR, "view:cache failed\n");
    exit(1);
}
passthru('php artisan event:cache');

// A throwaway database so authenticated pages can render.
touch('/app/database/bake.sqlite');
passthru('php artisan migrate --force --no-interaction');

require '/app/vendor/autoload.php';
$app = require '/app/bootstrap/app.php';
$kernel = $app->make(Illuminate\Contracts\Http\Kernel::class);
$kernel->bootstrap();

// Config cache from the HTTP kernel (artisan config:cache snapshots the
// CONSOLE kernel's view of config, which diverges for packages like Livewire).
file_put_contents(
    $app->getCachedConfigPath(),
    '<?php return ' . var_export($app['config']->all(), true) . ';' . PHP_EOL
);

$user = null;
if (class_exists(App\Models\User::class)) {
    $user = App\Models\User::query()->create([
        'name' => 'Bake',
        'email' => 'bake@localhost.test',
        'password' => bcrypt('bake-password'),
    ]);
}

$assetManifest = [];

$replay = function (string $uri, $user = null) use ($app, &$assetManifest) {
    // A fresh kernel per replayed request keeps middleware state honest.
    $kernel = $app->make(Illuminate\Contracts\Http\Kernel::class);
    if ($user) {
        Illuminate\Support\Facades\Auth::login($user);
    }
    $request = Illuminate\Http\Request::create('http://localhost' . $uri, 'GET', [], [], [], [
        'HTTP_ACCEPT' => 'text/html',
    ]);
    try {
        $response = $kernel->handle($request);
        printf("bake: GET %-24s %d\n", $uri, $response->getStatusCode());

        // Vendor-served JS (Livewire/Flux routes) gets extracted to Static
        // Assets so those requests never boot PHP in production.
        $content = (string) $response->getContent();
        if (preg_match('#/livewire-[0-9a-f]+/(livewire[\w.-]*\.js)#', $content, $m)) {
            // Serve exactly the dist file the page references (a glob here once
            // grabbed livewire.csp.min.js — the CSP build restricts Alpine
            // expressions and is not a drop-in substitute).
            $dist = '/app/vendor/livewire/livewire/dist/' . $m[1];
            if (is_file($dist)) {
                $assetManifest[$m[0]] = $dist;
            }
        }
        if (str_contains($content, '/flux/flux.min.js') && is_file('/app/vendor/livewire/flux/dist/flux.min.js')) {
            $assetManifest['/flux/flux.min.js'] = '/app/vendor/livewire/flux/dist/flux.min.js';
        }

        $kernel->terminate($request, $response);
    } catch (Throwable $e) {
        printf("bake: GET %-24s FAILED: %s\n", $uri, $e->getMessage());
    }
    if ($user) {
        Illuminate\Support\Facades\Auth::logout();
    }
};

// Public pages.
foreach (['/', '/login', '/register', '/forgot-password'] as $uri) {
    $replay($uri);
}
// Authenticated pages (the production OOM case).
if ($user) {
    foreach (['/dashboard', '/settings/profile', '/settings/password', '/settings/appearance'] as $uri) {
        $replay($uri, $user);
    }
}

// Second Blade pass: Livewire 4 emits intermediate .blade.php sources of its
// own; compile any that the replay produced.
$compiled = 0;
$livewireViews = '/app/storage/framework/views/livewire/views';
if (is_dir($livewireViews)) {
    foreach (glob($livewireViews . '/*.blade.php') as $file) {
        try {
            $app['blade.compiler']->compile($file);
            $compiled++;
        } catch (Throwable $e) {
            fwrite(STDERR, "second-pass compile failed for {$file}: {$e->getMessage()}\n");
        }
    }
}

file_put_contents('/app/.bake-asset-manifest.json', json_encode($assetManifest, JSON_PRETTY_PRINT));

@unlink('/app/database/bake.sqlite');

$views = count(glob('/app/storage/framework/views/*.php'));
printf(
    "bake: done — %d compiled views, %d second-pass, config+events cached\n",
    $views,
    $compiled,
);
