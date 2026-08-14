// The Laravel dispatch scripts: PHP sources the runtime executes for HTTP
// requests, queue payloads, scheduled work and boot warmup. Moved verbatim
// from the original LaravelWorkerd runtime; behavior is contract-frozen by
// the beta probes.
import { metaToPhp } from '../../runtime/src/contracts.mjs';

export const DEFAULT_ENV = {
	APP_NAME: 'Laravel',
	APP_ENV: 'production',
	APP_DEBUG: 'false',
	APP_TIMEZONE: 'UTC',
	APP_URL: 'http://localhost',
	LOG_CHANNEL: 'stderr',
	LOG_LEVEL: 'debug',
	SESSION_DRIVER: 'cookie',
	CACHE_STORE: 'array',
	QUEUE_CONNECTION: 'sync',
	BROADCAST_CONNECTION: 'log',
	FILESYSTEM_DISK: 'local',
};

export const WARMUP = `<?php
try {
	require '/app/vendor/autoload.php';
	$app = require '/app/bootstrap/app.php';
	$kernel = $app->make(Illuminate\\Contracts\\Http\\Kernel::class);
	$kernel->bootstrap();

	// Config caching is skipped for now: Livewire 4 derives view-namespace
	// registrations from runtime config in a way a var_export cache breaks
	// (settings pages 500 with "No hint path defined for [layouts]").
	// Revisit with a Volt-aware cache once the interaction is fully mapped.

	$compiler = $app['blade.compiler'];
	$views = 0;
	$skipped = 0;
	$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator('/app/resources/views'));
	foreach ($it as $f) {
		if (!$f->isFile() || !str_ends_with($f->getPathname(), '.blade.php')) {
			continue;
		}
		// Livewire/Volt single-file components have their own compiler pass;
		// precompiling them with the stock Blade compiler poisons the view
		// cache. Leave them to compile lazily on first use.
		if (str_contains($f->getPathname(), '/livewire/') || str_contains($f->getPathname(), '/pages/')) {
			$skipped++;
			continue;
		}
		try {
			$compiler->compile($f->getPathname());
			$views++;
		} catch (Throwable $e) {
			$skipped++;
		}
	}
	echo "warmup: config cached, {$views} views compiled, {$skipped} deferred\\n";
} catch (Throwable $e) {
	echo "warmup failed: " . $e->getMessage() . "\\n";
}
`;

export const requestScript = (meta) => `<?php
$meta = json_decode(base64_decode('${metaToPhp(meta)}'), true);
$body = is_file('/req.body') ? file_get_contents('/req.body') : '';
@unlink('/req.body');

putenv('PHP_BINARY=/usr/bin/php'); // short-circuits Symfony PhpExecutableFinder (fork-free)
require '/app/vendor/autoload.php';

$server = [
	'SCRIPT_NAME'     => '/index.php',
	'SCRIPT_FILENAME' => '/app/public/index.php',
	'DOCUMENT_ROOT'   => '/app/public',
	'SERVER_PROTOCOL' => 'HTTP/1.1',
	'REMOTE_ADDR'     => $meta['remoteAddr'],
	'SERVER_NAME'     => $meta['hostname'],
	'SERVER_PORT'     => $meta['port'],
];
foreach ($meta['headers'] as $name => $value) {
	$key = strtoupper(str_replace('-', '_', $name));
	if ($key === 'CONTENT_TYPE' || $key === 'CONTENT_LENGTH') {
		$server[$key] = $value;
	} else {
		$server['HTTP_' . $key] = $value;
	}
}

$cookies = [];
foreach (explode(';', $meta['headers']['cookie'] ?? '') as $pair) {
	$pair = trim($pair);
	if ($pair === '' || !str_contains($pair, '=')) continue;
	[$k, $v] = explode('=', $pair, 2);
	$cookies[urldecode($k)] = urldecode($v);
}

$params = [];
$files = [];
$ct = $server['CONTENT_TYPE'] ?? '';
if (in_array($meta['method'], ['POST', 'PUT', 'PATCH', 'DELETE'], true)
	&& str_starts_with($ct, 'application/x-www-form-urlencoded')) {
	parse_str($body, $params);
}

// Multipart bodies never pass through PHP's SAPI rfc1867 parser here (the
// request is reconstructed, not received), so populate params/$files by hand.
// Field names go through parse_str so name[] and nested[keys] behave; file
// inputs support flat names and name[] (deep nesting is out of scope).
if (in_array($meta['method'], ['POST', 'PUT', 'PATCH', 'DELETE'], true)
	&& str_starts_with($ct, 'multipart/form-data')
	&& preg_match('/boundary="?([^";]+)"?/', $ct, $bm)) {
	$pairs = [];
	$uploadIndex = 0;
	foreach (explode("\\r\\n--" . $bm[1], "\\r\\n" . $body) as $part) {
		if ($part === '' || str_starts_with($part, '--')) continue;
		$split = strpos($part, "\\r\\n\\r\\n");
		if ($split === false) continue;
		$rawHeaders = substr($part, 0, $split);
		// The part's trailing CRLF belongs to the NEXT delimiter and was
		// already consumed by the explode; the content is exact as-is.
		$content = substr($part, $split + 4);
		if (!preg_match('/content-disposition:.*?[; ]name="([^"]*)"/is', $rawHeaders, $dm)) continue;
		$name = $dm[1];
		if (preg_match('/[; ]filename="([^"]*)"/i', $rawHeaders, $fm)) {
			if ($fm[1] === '') continue; // empty file input submitted
			$tmp = '/tmp/php-upload-' . $uploadIndex++;
			file_put_contents($tmp, $content);
			$type = preg_match('/content-type:[ \\t]*([^\\r\\n]+)/i', $rawHeaders, $tm) ? trim($tm[1]) : 'application/octet-stream';
			// Test mode: these never passed the SAPI upload machinery, so
			// is_uploaded_file() is false and a non-test UploadedFile fails
			// isValid() (and every file/image validation rule with it). It
			// must be Illuminate's class: createFromBase() re-wraps foreign
			// instances with test=false, but passes its own kind through.
			$entry = new Illuminate\\Http\\UploadedFile(
				$tmp, $fm[1], $type, UPLOAD_ERR_OK, true,
			);
			if (str_ends_with($name, '[]')) {
				$files[substr($name, 0, -2)][] = $entry;
			} else {
				$files[$name] = $entry;
			}
		} else {
			$pairs[] = urlencode($name) . '=' . urlencode($content);
		}
	}
	if ($pairs) {
		parse_str(implode('&', $pairs), $params);
	}
}

$app = require '/app/bootstrap/app.php';

// Baked config caches ship with dummy secrets (the zip is secret-free); real
// values arrive from Worker env/secrets and are applied the moment config loads.
$app->afterBootstrapping(Illuminate\\Foundation\\Bootstrap\\LoadConfiguration::class, function ($app) use ($meta) {
	foreach (($meta['secrets'] ?? []) as $key => $value) {
		$app['config']->set($key, $value);
	}
});

$kernel = $app->make(Illuminate\\Contracts\\Http\\Kernel::class);
$request = Illuminate\\Http\\Request::create(
	$meta['scheme'] . '://' . $meta['host'] . $meta['uri'],
	$meta['method'],
	$params,
	$cookies,
	$files,
	$server,
	$body
);
$response = $kernel->handle($request);

ob_start();
$response->sendContent();
$content = ob_get_clean();

$headers = [];
foreach ($response->headers->allPreserveCaseWithoutCookies() as $name => $values) {
	$headers[$name] = array_values($values);
}
$envelope = [
	'status'  => $response->getStatusCode(),
	'headers' => $headers,
	'cookies' => array_map('strval', $response->headers->getCookies()),
	'body'    => base64_encode($content),
	'metrics' => [
		'peak_bytes' => memory_get_peak_usage(false),
		'mem_bytes'  => memory_get_usage(false),
		'files'      => count(get_included_files()),
	],
];
$kernel->terminate($request, $response);
echo "\\n@@ENV@@" . base64_encode(json_encode($envelope)) . "@@/ENV@@\\n";
`;

export // Runs one queued payload through Laravel's own job machinery. SyncJob is the
// perfect in-process executor: it resolves the payload's handler exactly as a
// worker would, fires failure events, and rethrows — retries stay Cloudflare
// Queues' job (message.retry()), so max_retries et al. behave natively.
const jobScript = (meta) => `<?php
$meta = json_decode(base64_decode('${metaToPhp(meta)}'), true);

putenv('PHP_BINARY=/usr/bin/php'); // short-circuits Symfony PhpExecutableFinder (fork-free)
require '/app/vendor/autoload.php';
$app = require '/app/bootstrap/app.php';
$app->afterBootstrapping(Illuminate\\Foundation\\Bootstrap\\LoadConfiguration::class, function ($app) use ($meta) {
	foreach (($meta['secrets'] ?? []) as $key => $value) {
		$app['config']->set($key, $value);
	}
});
try {
	$kernel = $app->make(Illuminate\\Contracts\\Http\\Kernel::class);
	$kernel->bootstrap();

	$job = new Illuminate\\Queue\\Jobs\\SyncJob($app, $meta['payload'], 'cloudflare', $meta['queue']);
	$job->fire();
	$envelope = ['ok' => true];
} catch (Throwable $e) {
	$envelope = ['ok' => false, 'error' => get_class($e) . ': ' . $e->getMessage()];
}
echo "\\n@@ENV@@" . base64_encode(json_encode($envelope)) . "@@/ENV@@\\n";
`;

export // Runs due scheduled events in-process. Closure/job events run; command
// events would exec artisan — impossible in wasm — and are skipped loudly.
const scheduleScript = (meta) => `<?php
$meta = json_decode(base64_decode('${metaToPhp(meta)}'), true);

putenv('PHP_BINARY=/usr/bin/php'); // short-circuits Symfony PhpExecutableFinder (fork-free)
require '/app/vendor/autoload.php';
$app = require '/app/bootstrap/app.php';
$app->afterBootstrapping(Illuminate\\Foundation\\Bootstrap\\LoadConfiguration::class, function ($app) use ($meta) {
	foreach (($meta['secrets'] ?? []) as $key => $value) {
		$app['config']->set($key, $value);
	}
});
try {
	$app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();

	$schedule = $app->make(Illuminate\\Console\\Scheduling\\Schedule::class);
	$ran = 0; $skipped = 0; $failed = 0;
	foreach ($schedule->dueEvents($app) as $event) {
		if (! $event instanceof Illuminate\\Console\\Scheduling\\CallbackEvent) {
			error_log("schedule: skipping command event (exec unavailable): {$event->getSummaryForDisplay()}");
			$skipped++;
			continue;
		}
		try {
			if ($event->filtersPass($app)) {
				$event->run($app);
				$ran++;
			}
		} catch (Throwable $e) {
			error_log('schedule: ' . $e->getMessage());
			$failed++;
		}
	}
	$envelope = ['ok' => true, 'ran' => $ran, 'skipped' => $skipped, 'failed' => $failed];
} catch (Throwable $e) {
	$envelope = [
		'ok' => false,
		'error' => get_class($e) . ': ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine(),
	];
}
echo "\\n@@ENV@@" . base64_encode(json_encode($envelope)) . "@@/ENV@@\\n";
`;
