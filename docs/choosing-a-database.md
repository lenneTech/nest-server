# Choosing a database

Since 12.1.0 a `@lenne.tech/nest-server` project stores its data in **MongoDB** (the default), in **PostgreSQL**, or
in both, model by model. The framework's own modules (users, Better-Auth, tenants, API tokens, AI, file metadata,
locks, migrations) run on either, behind one `CrudService` and one security pipeline. This document is the decision
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
5. **MySQL / MariaDB** only when required by step 1 — not before the release that supports them (phase 6). There the
   tenant isolation lives in the application only; say so in the project's documentation.
6. **No database** (`database: false`) for a stateless service: a gateway, a renderer, a worker that only talks to
   other APIs.

When the signals are ambiguous, **ask** — and record the decision (database, SQL engine, date, reason) in the
project's `CLAUDE.md`, so the next developer or agent does not re-decide it.

## The SQL engine

On PostgreSQL the framework compiles every query itself; the engine only carries the statements, so the choice does
not change behaviour, tables or security — switching later is configuration only (`database.sqlEngine`).

| Engine | When |
|---|---|
| **TypeORM** (default) | unless the team asks for another — the widest ecosystem |
| **Kysely** | the team writes typed SQL by hand in its own code and wants the builder it knows |
| **Drizzle** | the team already uses Drizzle elsewhere (pinned to an exact release candidate until 1.0 GA) |

Each engine is an optional peer dependency installed together with `pg`. Project code that uses an engine's native
API (`store.native()`) is the one part that does not move with a switch.

## What a project installs

| Database | Packages |
|---|---|
| MongoDB | `mongoose`, `@nestjs/mongoose`, `mongodb` (optional peers since 12.1.0 — the starter declares them) |
| PostgreSQL | `pg` plus the engine (`typeorm`, `kysely` or `drizzle-orm`) — and **none** of MongoDB's packages (npm mode; a vendor-mode project keeps the three as `devDependencies`, because the vendored core imports their types) |
| Both | both sets |

A project on PostgreSQL alone declares its models with the framework's own decorators, imported from
`@lenne.tech/nest-server` rather than `@nestjs/mongoose` (`Schema`, `Prop`, `SchemaFactory`, `InjectModel`), and
registers them with `CorePersistenceModule.forFeature()`. The same file works on MongoDB unchanged.

## Configuration in one line each

```typescript
// MongoDB (default) — nothing to configure beyond `mongoose`
mongoose: { uri: 'mongodb://127.0.0.1/project' }

// PostgreSQL: the application role, and the owner role that migrates the schema
database: { url: 'postgres://app@db/project', ownerUrl: 'postgres://owner@db/project', sqlEngine: 'typeorm' }

// Hybrid: PostgreSQL by default, these models in the project's MongoDB
database: { url: 'postgres://app@db/project', ownerUrl: '…', models: { Article: 'mongoose' } },
mongoose: { uri: 'mongodb://127.0.0.1/project' }

// No database
database: false
```

PostgreSQL always runs with **two roles**: the owner creates and migrates the schema, the application role owns
nothing and has neither superuser nor `BYPASSRLS` — the boot refuses an application role that could bypass row-level
security. PostgreSQL 15 or newer.
