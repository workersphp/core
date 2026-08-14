# DRAFT — not filed

- **Target repo:** seanmorris/pdo-cfd1 (issue with patch attached; user may prefer a PR)
- **Files under:** the user's GitHub identity, after their review
- **Suggested title:** lastInsertId() is an unimplemented stub returning 0 — breaks every ORM insert (Eloquent, Doctrine)

---

## Body

`pdo_cfd1_last_insert_id()` in `pdo_cfd1_db.c` is currently a stub: it
`console.log`s and returns 0. Any ORM that reads the insert id back after a
write gets 0 — in Laravel, every `Model::create()` returns a model with
`id = 0`, which then corrupts relations and route-model binding; Doctrine's
identity map has the same problem.

D1 already returns the needed value: the query result's `meta.last_row_id`.
The fix is to capture it in the statement-execute path and surface it from
the stub. Patch we've been shipping in production (also attached as a file):

```diff
--- a/pdo_cfd1_db.c
+++ b/pdo_cfd1_db.c
@@ static zend_string *pdo_cfd1_last_insert_id(pdo_dbh_t *dbh, const zend_string *name)
-	const char *nameStr = ZSTR_VAL(name);
 #if PHP_MAJOR_VERSION >= 8 && PHP_MINOR_VERSION >= 1
 	return zend_ulong_to_str
 #else
 	return zend_long_to_str
 #endif
-	(EM_ASM_INT({
-		console.log('LAST INSERT ID', UTF8ToString($0));
-		return 0;
-	}, &nameStr));
+	((zend_ulong) EM_ASM_DOUBLE({
+		return Module.__cfd1LastRowId || 0;
+	}));

--- a/pdo_cfd1_db_statement.c
+++ b/pdo_cfd1_db_statement.c
@@ EM_ASYNC_JS(int, pdo_cfd1_real_stmt_execute, (zval *zv, zval *rv), {
 		return false;
 	}

+	Module.__cfd1LastRowId = (result.meta && result.meta.last_row_id) || Module.__cfd1LastRowId || 0;
+
 	Module.jsToZval(result.results, rv);
```

`EM_ASM_DOUBLE` rather than `EM_ASM_INT` so ids above 2^31 survive the
crossing; the `|| Module.__cfd1LastRowId` keeps the previous id for
statements whose meta carries no `last_row_id` (SELECTs), matching SQLite's
`last_insert_rowid()` semantics.

With this in place, Laravel's Eloquent inserts work end-to-end against D1 in
production. Happy to open it as a PR instead if that's easier.

---

## Notes for the filer

- Patch file in this repo: `build-php/patches/pdo-cfd1-last-insert-id.patch`.
- Worth mentioning in passing (separate concern, document-not-fix): the
  driver's BEGIN/COMMIT/ROLLBACK are console.log no-ops — D1 has no
  interactive transactions, so that is arguably correct, but a README note
  would save users a surprise.
