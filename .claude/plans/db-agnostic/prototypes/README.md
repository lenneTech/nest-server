# Prototypes behind PLAN.md §5

Throwaway scripts that validated the plan's assumptions on 2026-10-27. They are evidence, not product code: outside
`src/`, `tests/` and `scripts/`, so neither lint, format nor the npm package sees them. Delete this folder together
with PLAN.md when `feat/db-agnostic` merges.

## Running them

Install the pinned dependencies in a copy of this folder (never inside the repo — the repo is a pnpm workspace) and
start the throwaway databases. The credentials are local container defaults, not secrets.

```bash
cp -R .claude/plans/db-agnostic/prototypes /tmp/db-proto && cd /tmp/db-proto && npm install
docker run -d --name nest-server-proto-pg -p 5434:5432 -e POSTGRES_USER=proto_owner -e POSTGRES_PASSWORD=proto -e POSTGRES_DB=proto postgres:18-alpine
docker run -d --name nest-server-proto-mariadb -p 3307:3306 -e MARIADB_ROOT_PASSWORD=proto -e MARIADB_DATABASE=proto mariadb:11.8
docker run -d --name nest-server-proto-mysql -p 3308:3306 -e MYSQL_ROOT_PASSWORD=proto -e MYSQL_DATABASE=proto mysql:8.4
node 16-engine-switch.mjs        # MongoDB on 127.0.0.1:27017 is needed by the parity scripts
GUARD=1 node 17-pool-fault.mjs   # without GUARD=1 it shows the defect, with it the fix
docker rm -f nest-server-proto-pg nest-server-proto-mariadb nest-server-proto-mysql
```

## What each script proves

| Script | Plan § | Result |
|---|---|---|
| `01-rls-failclosed.mjs` | A3 | RLS as a non-owner role: own rows only, raw SQL filtered, missing context raises `42501`, no leak to the next transaction |
| `02-claims-jsonb.mjs` | A4, A5 | atomic lease claim (exactly one winner of 16), atomic JSONB push/pull under concurrency |
| `03-where-parity.mjs`, `09-*`, `where-compiler-*.mjs` | A2 | Mongo-operator subset compiled to SQL: 28/28 identical to MongoDB, 1 different by design |
| `04-schema-generation.mjs` | A7 | metadata → DDL + additive diff |
| `05-better-auth-postgres.mjs`, `05b-roles-input-false.mjs` | A6 | Better-Auth on Postgres with ObjectId-hex ids and snake_case; `roles` stays server-managed |
| `06-require-esm.cjs` | A1 | the SQL packages load via `require()` |
| `07-typeorm.mjs`, `08-better-auth-on-typeorm-pool.mjs` | A8 | TypeORM 1.1 with runtime `EntitySchema`; Better-Auth on TypeORM's pg pool |
| `10-schema-evolution.mjs`, `10b-*` | A12 | TypeORM `synchronize` loses data on rename/type change; MikroORM guesses renames wrong |
| `11-drizzle.mjs` | A8, A12 | Drizzle 1.0 RC: parity, claim, RLS `42501`; `drizzle-kit` refuses ambiguous changes without hints |
| `12-mysql-mariadb.mjs`, `15-kysely-mysql-mariadb.mjs` | A11 | Drizzle, TypeORM, Kysely on MariaDB 11.8 / MySQL 8.4: JSON, rollback, claim; Kysely's migrator lock holds under 6 concurrent boots |
| `13-benchmark.mjs`, `13b-*` | A8 | store-path overhead against raw `pg` |
| `14-decision-matrix.mjs` | §4 | the weighted engine comparison, every score with its evidence |
| `16-engine-switch.mjs` | A9 | one store scenario, four adapters, switched by a config string: identical results, native handle on the store's transaction |
| `17-pool-fault.mjs` | A10 | timed-out transactions: TypeORM leaks, Kysely poisons the pool (tenant setting visible); the framework pool guard fixes all four |
| `18-tx-granularity.mjs` | A13 | per-operation (naive, combined, pipelined) against per-request transactions on a FORCE-RLS table as a non-owner role |
| `19-mysql-tenant-trigger.mjs` | phase 6 | a trigger write guard on MySQL / MariaDB: −17 to −49 % write throughput, stops scope-less native writes only; native reads, a scope left on a pooled connection and self-set variables pass — not built |
