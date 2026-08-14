#!/usr/bin/env bash
# Blade lint: compile every view on host PHP and syntax-check the output.
#
#   tools/blade-lint.sh <app-dir>
#
# Catches Blade templates that compile to broken PHP before they reach a
# deploy (the {{{{ quadruple-brace class of bug). Run BEFORE pack --bake:
# view:cache recompiles storage/framework/views with host paths, and the bake
# regenerates them with /app paths afterwards.
#
# The baked config cache pins paths to /app, which breaks artisan on the host,
# so it is removed first; the next bake recreates it.
set -euo pipefail

app="${1:?usage: blade-lint.sh <app-dir>}"
cd "$app"

rm -f bootstrap/cache/config.php
php artisan view:clear --quiet
php artisan view:cache --quiet

fail=0
count=0
for f in storage/framework/views/*.php storage/framework/views/**/*.php; do
  [ -f "$f" ] || continue
  count=$((count + 1))
  if ! php -l "$f" > /dev/null 2>&1; then
    echo "SYNTAX ERROR in compiled view: $f" >&2
    php -l "$f" >&2 || true
    fail=1
  fi
done

echo "[blade-lint] $count compiled views checked in $app"
exit $fail
