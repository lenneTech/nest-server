---
name: sync-release-cross-phase-facts
description: 12.2.0 release review (2026-11-01, 78db22b) — CoreModule's "no sync config → no CoreSyncModule" gate is asserted by no test; check-mutations ignores `drivers`; contract-suite history across DEV-3901..3903
metadata:
  type: project
---

Release-level test review of `12.1.1...78db22b` (offline sync phases DEV-3899..3903 + DEV-3910 sharding). Static only
(resource rule); unit guards regression-evidence, test-file-routing, postgres-e2e-coverage, sync-contract-matrix green.

**Reported High:** `src/core.module.ts` (~l. 680) imports `CoreSyncModule` only when `config.sync` is `true` / an
object without `enabled: false`. No test inspects `CoreModule.forRoot().imports` for it or asserts the absence of
`/sync`, the `syncHint` subscription or the `SyncMutation` / `SyncState` stores. Inverting the gate survives the suite:
e2e/ci envs never reach `resolveCursorSecret()`'s production refusal, no synchronized model → only a warning,
`server.e2e-spec` checks only `queryType.name`, the Hub persistence panel case uses `.find()`. In production without
`sync.cursorSecret` / `SECRETS_ENCRYPTION_KEY` the inverted gate fails every boot. Seam:
`tests/unit/core-module-signatures.spec.ts` (`result.imports`). Check whether a case + mutation was added before
re-reporting.

**Facts:**
- `scripts/check-mutations.mjs` never reads `driverSpecific` / `drivers`; red on ANY column of the spec file counts.
  `regression-evidence.spec` only requires `drivers` non-empty for driver-specific entries. So a `drivers` list is a
  claim nobody checks — verify it by reading the code path (e.g. `sync-migration-update-unversioned`: both dialects
  go through `writeSyncUpdate()` l. 147, claim holds).
- Contract suite history: DEV-3902 purely additive (337+/0-); DEV-3903 moved `databaseFor()`/`boot()` verbatim into
  `tests/helpers/sync-test-databases.ts` / `sync-test-app.ts` (same module order, same 7 columns; DB labels now `sync`,
  clock suite `clock`).
- DEV-3903 per-PR Highs ([[offline-sync-clients-skew-test-facts]]) all fixed in 78db22b: clock suite pins
  `pull.windowSeconds: 2` + mutation `sync-mongo-stamp-app-clock`; push lists and marks `attempted` in ONE
  `store.run`; fold guard `!attempted` is never reset.
- `mongoose-plugins.e2e-spec` 48 deleted lines in DEV-3900 are oxfmt reflow only.
- Store-level "model without sync unchanged" IS proven: parity `sync-model-unaffected` on all 10 columns.

**How to apply:** for an opt-in module gated in `CoreModule.forRoot()`, ask for a unit case on the imports for absent /
`false` / `{ enabled: false }` / `true`, with a mutation flipping the condition.

**Resolved before the 12.2.0 release:** the gate is pinned by `tests/unit/core-module-signatures.spec.ts` ("offline sync registration"), mutation `sync-module-registered-without-config`.
