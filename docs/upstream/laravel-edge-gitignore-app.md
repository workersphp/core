# DRAFT — not filed

- **Target repo:** togishima/laravel-edge (issue)
- **Files under:** the user's GitHub identity, after their review
- **Suggested title:** .gitignore hides app13/app/ — the AppServiceProvider that registers the cfd1 driver is missing from a fresh clone

---

## Body

First: thank you for laravel-edge. It is the map we used to get Laravel
running on Workers ourselves, and the war-stories doc saved us weeks. We
credit it prominently.

Small find while building on the repo: the root `.gitignore`'s `app/` rule
also matches `app13/app/`, so a fresh clone is missing that whole directory —
including the `AppServiceProvider` that registers the `cfd1` database driver
via `Connection::resolverFor()`. Without it the app13 example can't boot as
published (`Unsupported driver [cfd1]` on first DB touch).

Suggested one-line fix, either:

```
# .gitignore
!app13/app/
```

or scoping the original rule to the Laravel skeleton directory it was meant
for.

For anyone else who hits this before a fix lands: the missing piece is a
provider that does roughly

```php
Connection::resolverFor('cfd1', function ($connection, $database, $prefix, $config) {
    unset($config['foreign_key_constraints']); // D1 rejects PRAGMA through the driver
    return new SQLiteConnection(new PDO('cfd1:' . $database), $database, $prefix, $config);
});
```

Thanks again for pioneering this.
