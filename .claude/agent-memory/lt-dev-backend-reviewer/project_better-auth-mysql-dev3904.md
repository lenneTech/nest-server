---
name: project_better-auth-mysql-dev3904
description: DEV-3904 (12.1.1) Better-Auth on MySQL/MariaDB reviewed clean — foreignPool wrapper, collation swap, PG path parity and the IamSqlStorage change verified; what not to re-flag
metadata:
  type: project
---

DEV-3904 lets Better-Auth run on MySQL / MariaDB sources (2026-10-29 review: zero Critical/High).

Verified, do not re-flag:
- `SqlDialect.foreignPool()` on MySQL = `driverPool.promise()`; Better-Auth detects it by `getConnection`, builds `new MysqlDialect(wrapper)`, and Kysely's MysqlDriver spreads the config and reads `.pool` — an OWN property of mysql2's PromisePool, i.e. the framework's callback pool whose `'connection'` event applies `MYSQL_SESSION_SQL` (UTC, strict). `.promise()` per call adds no listeners (inheritEvents subscribes lazily).
- PG path identical: appRole from the dialect context is the same `decodeURIComponent(new URL(url).username)`; lock/grants/assertSafeApplicationRole moved verbatim. `queryOn()` now runs via `executor.run(…, SYSTEM)` (BEGIN · set_config system · stmt · COMMIT) instead of raw `pool.query` — DDL in that txn is fine on PG; counts lose `::int`, pg returns bigint as string → `Number()`.
- MySQL `$n` → `?` via `toMysqlStatement()` handles a repeated `$1` (migrationCounts) and LIMIT is client-side interpolated (`promisePool.query`), so `LIMIT ?` is safe.
- GET_LOCK is session-scoped and survives the implicit commit of `ALTER DATABASE`; `withMysqlSchemaLock` already ran DDL on its tx connection before this change (applyMysqlSchema).
- Session/account cleanup on user delete does NOT rely on FK cascade (MySQL 8.4 ignores Kysely's inline REFERENCES): `deleteUserFromBothSystemsOnSql` deletes sessions/accounts explicitly.
- `IamSqlStorage` gained required `driver` / `query`: only `DataSourceRuntime` implements it; `BetterAuthSqlStore` is not barrel-exported; nest-server-starter references neither.
- mysql2 object-injection via `/iam/update-user` is closed by the `>=3.24.6` peer floor (sql-escaper SET-context rule) — security reviewer's finding, see their memory.

Coverage: `iam-mysql` / `iam-mariadb` vitest projects (default engine typeorm only) + `persistence-mysql-wiring` on a server-default-collation DB (mutation `mysql-iam-tables-default-collation`). Kysely/Drizzle engines on MySQL are NOT exercised for Better-Auth, but foreignPool/run are engine-independent (all three share `createPool`).

Related: [[project_db-agnostic-phase6]], [[project_db-agnostic-phase3]].
