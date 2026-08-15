# Releasing

Versioning: `@workersphp/runtime`, `@workersphp/laravel`, `@workersphp/cli`
and `workersphp/laravel-bridge` move in lockstep on a `v0.x.y` tag.
`@workersphp/php-wasm-jspi` versions independently and bumps only when the
binary is rebuilt.

## Package release (lockstep)

1. Green CI on main. Update CHANGELOG.md.
2. Bump versions in the three npm package.json files and remove their
   `"private": true` guards (present until first publish to prevent
   accidents).
3. `npm publish -w packages/runtime -w packages/laravel -w packages/cli --access public`
4. `git tag v0.x.y && git push --tags`, then update the mirror:

   ```sh
   git subtree split --prefix=packages/laravel-bridge -b lc-split
   git push -f git@github.com:workersphp/laravel-bridge.git lc-split:main
   git push git@github.com:workersphp/laravel-bridge.git v0.x.y
   git branch -D lc-split
   ```

   Packagist picks the push up automatically via the GitHub webhook.
5. `gh release create v0.x.y` with release notes.

## Binary release

1. Rebuild per `build-php/REBUILD.md`; verify `grep -c 'invoke_'` is 0 in the
   glue for the JSPI variant.
2. Run the full test suite against the new binary; deploy a beta twin and run
   `node tools/probe.mjs --target beta --rw`.
3. Copy artifacts into `packages/php-wasm-jspi/`, compute sha256s into its
   README, bump its version, `npm publish --access public`.
4. `gh release upload` the wasm + glue + sha256sums.txt to the current
   release for provenance.
