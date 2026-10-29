---
name: project-betterauth-mysql-dev3904-facts
description: DEV-3904 Better-Auth on MySQL/MariaDB traced sound — mysql2 object-injection closed by sql-escaper SET-context rule, type juggling dead-ends, collation swap safe
metadata:
  type: project
---

DEV-3904 (12.1.1, 2026-10-29) lets Better-Auth run its Kysely adapter on the framework's `mysql2` pool (promise wrapper via `SqlDialect.foreignPool()`). Reviewed, zero Critical/High.

Facts that settle the recurring worries:

- **mysql2 object injection (`WHERE pw = ?` with `{pw:1}` / `SET name = ?` with `{name:1, roles:'…'}`) is CLOSED.** Kysely's MysqlDriver uses client-side `query(sql, params)`, the pool sets no `stringifyObjects`, BUT mysql2 >= 3.24.6 (the peer floor) depends on `sql-escaper ^1.5.1`, which expands an object into `key = value` pairs ONLY after a bare `SET ?` / a comma inside such a list. Kysely always emits `col = ?`, so an object becomes `'[object Object]'`. Arrays become escaped literal lists (`'a', 'b'`) — syntax error, never an identifier. Probe: `node -e "const m=require('mysql2');console.log(m.format('update t set a = ?, b = ? where id = ?',[{a:1,roles:'x'},['p','q'],'i']))"`. If the mysql2 peer floor is ever lowered below a version shipping sql-escaper >= 1.5.1, RE-CHECK: `/iam/update-user` takes `name`/`image` as `z.any()` and would then be a self-grant of `roles`.
- **MySQL numeric type juggling** (`'abc' = 0` is true) needs a non-string value in a WHERE. Loose schemas in the registered plugins: `update-user`/`update-session` (SET only), passkey `verify-authentication` `response.id` (selects SOME passkey, then simplewebauthn signature verification against its public key fails). No path.
- Framework's own MySQL path refuses object params outright (`driverValue()` in `mysql-session.ts`).
- `withFrameworkDefaultCollation()`: charset/collation read from SCHEMATA, `^\w+$`-validated before interpolation; a crash mid-run leaves `utf8mb4_bin` (stricter). App account gets no extra rights — MySQL grants are DB-level DML from the framework's own run; `assertSafeMysqlApplicationAccount` re-checks.
- `users` has no `tenantId`, Better-Auth's tables are global on every database — no tenant-isolation gap from Better-Auth bypassing the MySQL store.

Related: [[project-db-agnostic-phase3-better-auth-sql-facts]], [[project-db-agnostic-phase6-mysql-facts]], [[project-betterauth-input-false-enforcement]].
