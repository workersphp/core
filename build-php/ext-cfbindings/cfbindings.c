/*
 * cfbindings: the narrowest possible bridge from PHP to Cloudflare bindings.
 *
 * One async entry point: cf_bindings_call(string $requestJson): string. The
 * request travels to Module.cfbindings (installed by the Workers runtime),
 * which awaits the binding operation (KV get, R2 read, ...) and answers with
 * {ok, value} or {ok: false, error}. All semantics live in JS and PHP
 * userland; this file should never need to change when operations are added.
 *
 * The await suspends the interpreter exactly like pdo_cfd1's D1 calls do —
 * EM_ASYNC_JS under ASYNCIFY=2 becomes a JSPI Suspending import.
 */
#ifdef HAVE_CONFIG_H
#include "config.h"
#endif

#include "php.h"
#include "ext/standard/info.h"
#include <emscripten.h>
#include <stdlib.h>

EM_ASYNC_JS(char*, cfb_js_call, (const char* request), {
	let payload;
	try {
		const handler = Module.cfbindings;
		if (!handler) {
			throw new Error('no cfbindings handler installed in this runtime');
		}
		payload = { ok: true, value: await handler(JSON.parse(UTF8ToString(request))) };
	} catch (error) {
		payload = { ok: false, error: String((error && error.message) || error) };
	}
	const s = JSON.stringify(payload);
	const len = lengthBytesUTF8(s) + 1;
	const buf = _malloc(len);
	stringToUTF8(s, buf, len);
	return buf;
});

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_cf_bindings_call, 0, 1, IS_STRING, 0)
	ZEND_ARG_TYPE_INFO(0, request, IS_STRING, 0)
ZEND_END_ARG_INFO()

PHP_FUNCTION(cf_bindings_call)
{
	char *request;
	size_t request_len;

	ZEND_PARSE_PARAMETERS_START(1, 1)
		Z_PARAM_STRING(request, request_len)
	ZEND_PARSE_PARAMETERS_END();

	char *result = cfb_js_call(request);
	if (result == NULL) {
		RETURN_STRING("{\"ok\":false,\"error\":\"bridge returned null\"}");
	}
	RETVAL_STRING(result);
	free(result);
}

static const zend_function_entry cfbindings_functions[] = {
	PHP_FE(cf_bindings_call, arginfo_cf_bindings_call)
	PHP_FE_END
};

PHP_MINFO_FUNCTION(cfbindings)
{
	php_info_print_table_start();
	php_info_print_table_row(2, "cfbindings support", "enabled");
	php_info_print_table_end();
}

zend_module_entry cfbindings_module_entry = {
	STANDARD_MODULE_HEADER,
	"cfbindings",
	cfbindings_functions,
	NULL, /* MINIT */
	NULL, /* MSHUTDOWN */
	NULL, /* RINIT */
	NULL, /* RSHUTDOWN */
	PHP_MINFO(cfbindings),
	"0.1.0",
	STANDARD_MODULE_PROPERTIES
};

#ifdef COMPILE_DL_CFBINDINGS
ZEND_GET_MODULE(cfbindings)
#endif
