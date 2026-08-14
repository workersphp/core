PHP_ARG_ENABLE([cfbindings],
  [whether to enable the Cloudflare bindings bridge],
  [AS_HELP_STRING([--enable-cfbindings],
    [Enable the Cloudflare bindings bridge (wasm/workerd builds)])],
  [no])

if test "$PHP_CFBINDINGS" != "no"; then
  PHP_NEW_EXTENSION(cfbindings, cfbindings.c, $ext_shared)
fi
