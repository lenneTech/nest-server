# Choosing a database

Since 12.1.0 a `@lenne.tech/nest-server` project stores its data in **MongoDB** (the default), in **PostgreSQL**, in
**MySQL 8.4 / MariaDB 11.8**, or in several of them, model by model. The framework's own modules (users, tenants, API
tokens, AI, file metadata, locks, migrations) run on each, behind one `CrudService` and one security pipeline;
Better-Auth runs on MongoDB and PostgreSQL. This document is the decision
procedure — for a developer starting a project and for an AI agent asked to set one up. Configuration details are in
`.claude/rules/configurable-features.md` (row "Data Sources"); the code rules in `.claude/rules/persistence.md`.

## The procedure

Work through the steps in order; the first one that decides, decides.

1. **An external requirement wins.** The customer's operations team runs one database, a hosting contract names one,
   an existing system the project must read is one: take that database. Nothing below outweighs it.
2. **PostgreSQL** when the data is relational or reported on — accounting, invoices, bookings, inventory,
   anything with joins, sums across records or reports a finance team reads — or when **tenant isolation must be
   enforced by the database itself**. On PostgreSQL every tenant-scoped table carries forced row-level security, so
   a query that forgets its tenant returns nothing instead of every tenant's rows; MongoDB has the framework's two
   application layers only.
3. **MongoDB** (the default) for document-shaped data — nested content, free-form attributes, structures that change
   per customer — and whenever the signals above are absent. An existing MongoDB project stays on MongoDB: moving
   databases is a data migration, not a configuration change.
4. **Both (hybrid)** only with a concrete reason, written down: e.g. the finance models in PostgreSQL while the
   content stays in MongoDB. The cost is real — two databases to run, back up and monitor, no transaction across
   them, references across them resolved in the application. Route per model with `database.models`.
5. **MySQL / MariaDB** only when required by step 1. What a project gives up there, and has to write into its own
   documentation:
   - **Tenant isolation lives in the application only.** Neither database has row-level security: the store's
     policies keep tenants apart, and a query through `store.native()`, `store.raw()` or a connection of the project's
     own reaches every tenant's rows unless it filters by `tenantId` itself. The boot says so once per source. A
     trigger-based write guard was measured and not built: it cost up to half of MariaDB's write throughput and left
     the native read open.
   - **Better-Auth does not run there yet:** keep the user model (`users`) on PostgreSQL or MongoDB
     (`database.models`), or sign in through the legacy endpoints only. The boot refuses the combination.
   - **An indexed text field holds at most 255 characters** (a longer value is refused with 400); every other text is
     unbounded. Indexing an existing text field later is a type change, i.e. a reviewed migration.
   - **Schema changes are not transactional:** MySQL commits every DDL statement on its own, so a failed change leaves
     the statements before it applied; the next boot completes the rest.
6. **No database** (`database: false`) for a stateless service: a gateway, a renderer, a worker that only talks to
   other APIs.

When the signals are ambiguous, **ask** — and record the decision (database, SQL engine, date, reason) in the
project's `CLAUDE.md`, so the next developer or agent does not re-decide it.

## The SQL engine

On every SQL database the framework compiles every query itself; the engine only carries the statements, so the
choice does not change behaviour, tables or security — switching later is configuration only (`database.sqlEngine`).
All three engines run on PostgreSQL, MySQL and MariaDB.

| Engine | When |
|---|---|
| **TypeORM** (default) | unless the team asks for another — the widest ecosystem |
| **Kysely** | the team writes typed SQL by hand in its own code and wants the builder it knows |
| **Drizzle** | the team already uses Drizzle elsewhere (pinned to an exact release candidate until 1.0 GA) |

Each engine is an optional peer dependency installed together with the database's driver (`pg`, or `mysql2` for MySQL
and MariaDB). Project code that uses an engine's native API (`store.native()`) is the one part that does not move with a
switch.

## What a project installs

| Database | Packages |
|---|---|
| MongoDB | `mongoose`, `@nestjs/mongoose`, `mongodb` (optional peers since 12.1.0 — the starter declares them) |
| PostgreSQL | `pg` plus the engine (`typeorm`, `kysely` or `drizzle-orm`) — and **none** of MongoDB's packages (npm mode; a vendor-mode project keeps the three as `devDependencies`, because the vendored core imports their types) |
| MySQL / MariaDB | `mysql2` plus the engine — the same rule for MongoDB's packages as on PostgreSQL |

In **vendor mode** the core is the project's own source, and TypeScript resolves every package it names in an
`import()` — whatever database the project uses. A vendor project therefore declares `pg` (with `@types/pg`), `mysql2`,
`typeorm`, `kysely` and `drizzle-orm` (at least as `devDependencies`), or its build fails with TS2307. At runtime it loads only
what its configuration uses.
| Several | the sets combined |

A project on PostgreSQL alone declares its models with the framework's own decorators, imported from
`@lenne.tech/nest-server` rather than `@nestjs/mongoose` (`Schema`, `Prop`, `SchemaFactory`, `InjectModel`), and
registers them with `CorePersistenceModule.forFeature()`. The same file works on MongoDB unchanged.

## Configuration in one line each

```typescript
// MongoDB (default) — nothing to configure beyond `mongoose`
mongoose: { uri: 'mongodb://127.0.0.1/project' }

// PostgreSQL: the application role, and the owner role that migrates the schema
database: { url: 'postgres://app@db/project', ownerUrl: 'postgres://owner@db/project', sqlEngine: 'typeorm' }

// MySQL 8.4 or MariaDB 11.8: the scheme names the server (mysql:// or mariadb://)
database: { url: 'mysql://app@db/project', ownerUrl: 'mysql://owner@db/project' }

// Hybrid: PostgreSQL by default, these models in the project's MongoDB
database: { url: 'postgres://app@db/project', ownerUrl: '…', models: { Article: 'mongoose' } },
mongoose: { uri: 'mongodb://127.0.0.1/project' }

// No database
database: false
```

PostgreSQL always runs with **two roles**: the owner creates and migrates the schema, the application role owns
nothing and has neither superuser nor `BYPASSRLS` — the boot refuses an application role that could bypass row-level
security. PostgreSQL 15 or newer.

MySQL and MariaDB run with **two accounts** too: the owner creates and migrates the schema and grants the application
account `SELECT, INSERT, UPDATE, DELETE` on the database once; the boot refuses an application account that may alter,
drop, index, trigger or grant — without row-level security, the tables and their constraints are what the store's
policies rely on. MySQL 8.4 / MariaDB 11.8 or newer, and the URL's scheme must name the server it reaches.
