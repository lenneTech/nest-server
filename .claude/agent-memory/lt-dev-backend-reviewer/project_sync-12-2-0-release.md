---
name: sync-12-2-0-release
description: 12.2.0 release review of offline sync (12.1.1...78db22b, 2026-11-01) — 1 High (CoreSyncService not injectable by project modules); non-sync CrudService/store paths verified inert
metadata:
  type: project
---

Cross-phase review of the 12.2.0 release diff (DEV-3910, 3899–3903), 2026-11-01, by reading plus a Nest DI probe.

**Reported High:** `CoreSyncModule.forRoot()` is neither `global` nor re-exported by the `@Global()` `CoreModule`
(its `exports` list only holds ConfigService, Redis, S3, Email, Template, Mailjet). README, INTEGRATION-CHECKLIST and
the 12.2 migration guide tell projects to call `CoreSyncService.notifyChange()` / `bumpAccessEpoch()` /
`purgeTombstones()` — constructor injection in a project module fails the boot ("can't resolve … CoreSyncService"),
and `@Optional()` injection silently yields `undefined` (epochs never bumped after direct-store moves). Probed with a
mirror structure in scratchpad (`NestFactory.createApplicationContext(…, { abortOnError: false })` — without it Nest
exits 1 with no output when `logger: false`). Tests only use `moduleRef.get(CoreSyncService, { strict: false })`,
which is why nothing caught it. Fix: `global: true` on the dynamic module (as CoreApiTokenModule / CoreTenantModule)
or export `CoreSyncModule` from CoreModule when registered.

**Verified sound (don't re-derive):** for a model without `sync`, every CrudService path is inert — `expectedVersionOf`
returns before touching the store, `syncAccessSnapshot` → undefined → `reportSyncAccessMove` returns, `reportSyncChange`
gated on `capabilities.changeOrder`, `withTombstones` gated on the schema symbol, `tombstoneOption` → `{}`; SQL
`where()` builds the same condition as 12.1.1; `withSequenceField` returns non-sync descriptors unchanged; PG/MySQL
migrators add nothing for non-sync tables (only a `{ deletedAt: null }` partial unique changes, which threw on MySQL
before). Sync module uses `includeTombstones`/`hardDelete`/`changeClock`/`changeOrder` as phase 3 implemented them on
both databases (`toMongoSort` maps `id`→`_id` for the purge and keyset). Registration: absent/false/`{enabled:false}`
→ nothing; `true`/`{}` → module. Madge still 6 known cycles; import-cycle/module-format/forwarding/descriptor unit
specs green. See [[offline-sync-phase5-dev3902]].

**Resolved before the 12.2.0 release:** `CoreSyncModule.forRoot()` returns `global: true` (pinned by `tests/unit/sync-module.spec.ts`, mutation `sync-module-not-global`).
