---
name: project-db-agnostic-phase6-mysql-facts
description: DEV-3848 (db-agnostic phase 6, MySQL/MariaDB) review 2026-10-29 — prototype pollution in the MySQL update compiler (reported), app-account check blind to roles/wildcard grants, what was traced sound, probe recipe against the test containers
metadata:
  type: project
---

Phase 6 review (feat/db-agnostic, eb215d4..7a72702). One reported finding; re-check whether it was fixed.

**Reported (re-verify):** `MysqlUpdateCompiler.addParents()` (`sql/mysql/mysql-update.compiler.ts`) does
`node[segment] ??= {}` over path segments that `isPathSegment()` accepts (`/^[A-Za-z_]\w*$/` admits `__proto__`,
`constructor`, `prototype`). `$set`/`$inc` on `<jsonField>.__proto__.<name>.<leaf>` (json = Mixed/Map/`type: Object`)
sets `Object.prototype.<name> = {}`. With `<name>` = `bypassTenantGuard`, `RequestContextMiddleware`'s literal context
inherits it → `isTenantPolicyBypassed()` true → no tenant filter and no row check for EVERY request (all databases)
until restart. Proven by probe (resolveTenantFilter `{tenantId}` → undefined). PostgreSQL compiler builds no object
(verified safe); Mongoose's mpath ignores those keys. Entry needs request data on an update PATH: default REST pipe
strips dotted keys, GraphQL types refuse them; reachable via `security.mapAndValidatePipe.nonWhitelistedFields: false`
(class-level `@Restricted` on the input then limits the actor) or project code building `$set` paths from request keys.

**Why:** the store is a public API whose docs promise descriptor-validated paths; MySQL is the only dialect that
materialises the path as a JS object.

**How to apply — below the bar, but answer if asked:**
- `assertSafeMysqlApplicationAccount` reads only the account's OWN grantee rows: DDL held through a MySQL 8 role
  (default role) or a wildcard db grant (`` `app%`.* ``) is invisible — verified with the real function (role → ACCEPTED,
  direct grant → REFUSED). Fix shape: `SHOW GRANTS` / APPLICABLE_ROLES expansion.
- The framework's own `GRANT … ON \`db_name\`.*` treats `_` as a wildcard (over-grant to look-alike databases).
- MariaDB roles CHECK reads the stored JSON TEXT: a raw/native write of `"s_self"` or `"s_self"` passes
  (MySQL normalises JSON, so only MariaDB). Store path never produces such escapes.
- `utf8mb4_bin` is PAD SPACE on both servers: `col = 'x'` matches `'x '`. Ids are strict hex, so no path found.

**Traced sound:** values only via `$n`→`?` + mysql2 client escaping (driverValue refuses objects/arrays; session
sql_mode without NO_BACKSLASH_ESCAPES, a failed SET destroys the connection); JSON paths from validated segments,
bound; no literal `?` or adjacent placeholders in compiled text; `readById` unfiltered but `toRecords` row check inside
the transaction (a tenant move rolls back); updateById/pushToArray/pullFromArray filter by `where({id})`;
updateOne/deleteOne lock with the tenant filter; system-role policy on every store write (scalar `roles` wrapped into
an array is caught by the CHECK); Better-Auth refused via `iamStorage()` (every caller throws → fail closed);
mapError messages carry no values; pnpm audit clean, mysql2 3.24.6 past the 2024 CVEs.

**Probe recipe:** containers `nest-server-2985-mysql` (3316) / `-mariadb` (3317), root pw `nest-root-secret`; probe
users via `docker exec … mysql -h 127.0.0.1 -uroot …` and DROP USER afterwards. Scratch `.mjs` importing
`src/**/*.ts` by absolute path, run `node -r ./src/core/modules/migrate/helpers/ts-compiler.js` with an explicit
`process.exit(0)` at the end — the mysql2 pool keeps the process alive otherwise (hung >90 s).

Related: [[project-db-agnostic-phase5-mongo-optional-facts]], [[project-primitive-body-args-bypass-validation]].
