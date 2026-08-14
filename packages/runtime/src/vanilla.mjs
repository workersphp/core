// The reference adapter: no framework, just a front controller. A request
// becomes CGI-shaped superglobals, the entrypoint is required, and whatever
// it echoes (plus headers_list) comes back as the response. This is both the
// smallest possible consumer of the adapter interface and the rehearsal for
// any future framework adapter (a Drupal adapter is this plus Drupal's boot
// conventions).
import { metaToPhp } from './contracts.mjs';

export function vanillaAdapter({ docroot = '/app', entrypoint = 'index.php' } = {}) {
	const requestScript = (meta) => `<?php
$meta = json_decode(base64_decode('${metaToPhp({
		...meta,
		docroot,
		script: `${docroot}/${entrypoint}`,
		query: meta.uri.includes('?') ? meta.uri.slice(meta.uri.indexOf('?') + 1) : '',
	})}'), true);
$body = is_file('/req.body') ? file_get_contents('/req.body') : '';
@unlink('/req.body');

$_SERVER = [
	'REQUEST_METHOD'  => $meta['method'],
	'REQUEST_URI'     => $meta['uri'],
	'QUERY_STRING'    => $meta['query'],
	'SCRIPT_NAME'     => '/' . basename($meta['script']),
	'PHP_SELF'        => '/' . basename($meta['script']),
	'SCRIPT_FILENAME' => $meta['script'],
	'DOCUMENT_ROOT'   => $meta['docroot'],
	'SERVER_PROTOCOL' => 'HTTP/1.1',
	'SERVER_SOFTWARE' => 'workersphp/runtime',
	'SERVER_NAME'     => $meta['hostname'],
	'SERVER_PORT'     => $meta['port'],
	'REMOTE_ADDR'     => $meta['remoteAddr'],
	'REQUEST_SCHEME'  => $meta['scheme'],
];
if ($meta['scheme'] === 'https') {
	$_SERVER['HTTPS'] = 'on';
}
foreach ($meta['headers'] as $name => $value) {
	$key = strtoupper(str_replace('-', '_', $name));
	if ($key === 'CONTENT_TYPE' || $key === 'CONTENT_LENGTH') {
		$_SERVER[$key] = $value;
	} else {
		$_SERVER['HTTP_' . $key] = $value;
	}
}

$_GET = [];
parse_str($meta['query'], $_GET);

$_COOKIE = [];
foreach (explode(';', $meta['headers']['cookie'] ?? '') as $pair) {
	$pair = trim($pair);
	if ($pair === '' || !str_contains($pair, '=')) continue;
	[$k, $v] = explode('=', $pair, 2);
	$_COOKIE[urldecode($k)] = urldecode($v);
}

$_POST = [];
$ct = $_SERVER['CONTENT_TYPE'] ?? '';
if (in_array($meta['method'], ['POST', 'PUT', 'PATCH', 'DELETE'], true)
	&& str_starts_with($ct, 'application/x-www-form-urlencoded')) {
	parse_str($body, $_POST);
}
$_REQUEST = array_merge($_GET, $_POST);
$_FILES = [];

$GLOBALS['__raw_body'] = $body;

chdir($meta['docroot']);

ob_start();
try {
	require $meta['script'];
} catch (Throwable $e) {
	http_response_code(500);
	echo '<h1>Unhandled ' . get_class($e) . '</h1><pre>'
		. htmlspecialchars($e->getMessage() . "\\n" . $e->getTraceAsString(), ENT_QUOTES)
		. '</pre>';
}
$content = ob_get_clean();

$headers = [];
foreach (headers_list() as $line) {
	if (!str_contains($line, ':')) continue;
	[$n, $v] = explode(':', $line, 2);
	$headers[trim($n)][] = trim($v);
}
$envelope = [
	'status'  => http_response_code() ?: 200,
	'headers' => $headers,
	'cookies' => [],
	'body'    => base64_encode($content),
];
echo "\\n@@ENV@@" . base64_encode(json_encode($envelope)) . "@@/ENV@@\\n";
`;

	return {
		name: 'vanilla',
		docroot,
		prepareBoot() {},
		needsWarmup: () => false,
		warmupScript: null,
		secrets: () => ({}),
		requestScript,
		jobScript: null,
		scheduleScript: null,
	};
}
