# DRAFT — not filed

- **Target repo:** livewire/livewire (docs/DX issue, not a bug report)
- **Files under:** the user's GitHub identity, after their review
- **Suggested title:** Default component layout namespace diverges from the official starter kits; a filesystem fallback masks the misconfiguration except on virtual filesystems

---

## Body

Framing this as a docs/DX suggestion rather than a bug, because on a normal
filesystem everything appears to work.

Livewire 4's default layout view namespace points at `resources/views/layouts`,
while the official Laravel starter kits ship their layouts under
`resources/views/components/layouts`. On a standard install the divergence is
invisible: a native-finder fallback locates the layout anyway.

We run Laravel inside Cloudflare Workers on a PHP-in-wasm build (Workers PHP),
where views live on a virtual filesystem (MEMFS). There the fallback does not
engage, and the starter kit fails hard on any full-page component render:

```
No hint path defined for [layouts].
```

Pinning the namespace explicitly fixes it:

```php
// config/livewire.php
'layout' => 'components.layouts.app',
```

Two suggestions, either of which would have saved the debugging session:

1. Align the default with the starter kits' `components/layouts` location, or
2. Document the pin in the upgrade/config docs, noting that the native-finder
   fallback is what makes the default appear correct on regular filesystems.

Happy to provide more environment detail if useful.

---

## Notes for the filer

- This is the most "exotic environment" of the four reports — the framing
  deliberately concedes that only virtual filesystems surface it, and asks
  for a docs fix first.
