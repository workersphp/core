# Upstream reports - status tracker

Four issues found while building Workers PHP, each already fixed or worked
around in our stack (nothing here blocks us). Drafts are ready to paste; none
has been filed yet. Searched each upstream tracker on 2026-08-15, including
closed issues: none of these has been reported by anyone.

| # | Draft | Target | Our side | Status |
|---|---|---|---|---|
| 1 | pdo-cfd1-lastinsertid.md | seanmorris/pdo-cfd1 | Patched at build time (build-php/patches/pdo-cfd1-last-insert-id.patch) | Draft ready. Repo has zero issues ever; ours would be the first. Filing eventually removes a patch we maintain. |
| 2 | php-wasm-frozen-clock-uniqid.md | seanmorris/php-wasm | Fixed in our runtime (nudgeClocks in packages/runtime/src/php.mjs, guarded by the frozen-clock test) | Draft ready. Tracker has nothing on clocks/uniqid/Cloudflare. Optional courtesy cross-post to WordPress/wordpress-playground included in the draft. |
| 3 | laravel-edge-gitignore-app.md | togishima/laravel-edge | No dependency; found while studying their repo | Draft ready. Repo has zero issues ever. Thirty-second kindness to the project we credit most. |
| 4 | livewire-layouts-namespace.md | livewire/livewire | Worked around per app (config/livewire.php layout pin in the starter app) | Draft ready, framed as a docs/DX suggestion. No tracker hit on the exact error string. Lowest priority. |

## To file one (from a gh-authenticated shell)

```sh
gh issue create --repo <target> --title "<Suggested title from the draft>" --body-file docs/upstream/<draft>.md
```

Strip the "DRAFT - not filed" header block from the body first; the suggested
title is in that header. Recommended order: 1, 3, 2, 4.

Update the Status column here after filing, with the issue URL.
