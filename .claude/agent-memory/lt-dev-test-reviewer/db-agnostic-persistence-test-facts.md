---
name: db-agnostic-persistence-test-facts
description: feat/db-agnostic phase 0 (2026-10-27) — what the persistence specs prove, which mutations were seen red, and the boot-guard gap (database option is guarded, never wired into the connection)
metadata:
  type: project
---

Reviewed 2026-10-27 on `feat/db-agnostic` (DEV-3828, phase 0).

**Seen red in a scratch copy** (see [[scratch-copy-mutation-check]]): `tenant-row-check-not-registered`
(2 cases), `lock-store-takes-held-lease` (5 of 6), and the three repointed ones
`exclude-schemas-warns-silently`, `cross-tenant-writes-accepted`, `malformed-file-id-500`. Re-run them
rather than trusting this list once the files move again.

**Boot-guard gap found:** `CoreModule.forRoot()` only CALLS `assertDataSourcesSupported(resolveDataSources(...))`;
the connection is still `MongooseModule.forRoot(config.mongoose.uri)`. So `database: 'mongodb://…'` without a
project `mongoose` key passes the guard and connects to `NSC__MONGOOSE__URI || mongodb://localhost/nest-server-default`.
`persistence-data-source-config.spec.ts` "CoreModule.forRoot wiring" covered only no-database and a SQL URL.
Check whether a later phase wires `database.url` before re-reporting.

**Why:** the guard's stated contract is "refuse what cannot be wired"; a pure-function probe
(`npx tsx` on `data-source.config.ts`) proves acceptance in seconds without touching the tree.

**How to apply:** for later phases, ask of every new `database` shape: is it refused, or is it actually
the URI the connection uses? A guard test that only checks "throws / does not throw" cannot tell.
