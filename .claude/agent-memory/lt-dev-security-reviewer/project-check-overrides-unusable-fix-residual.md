---
name: project-check-overrides-unusable-fix-residual
description: `auditConfig.unusableFixConsumers` in check-overrides (landed 11.42.5, multi-consumer ` + ` form 2026-10-31) — expiry checks, the parse-edge probe matrix that must stay fail-closed, starter port lag
metadata:
  type: project
---

**Status:** landed in nest-server 11.42.5 (2026-10-06) after two review rounds. Round 1 (first attempt,
reverted): backport and second parent stayed green. Round 2 found `dependentsOf()` reading only
`snapshots:` (a direct dependency in `importers:` stayed green) and parents compared by name only
(a second consumer version rode along). Both fixed; six `unusable-fix-*` mutations registered.

**Multi-consumer form (commit dcc1f0b, 2026-10-31, reviewed clean):** `'a@1 + b@2 cannot use X'`.
`expected` is an ARRAY and compared with `Array#includes` (exact element match, never substring); every
consumer gets the moved/absent check, then backport, then `others` (undeclared parent), then the new
`idle` check (declared consumer that pulls nothing affected, mutation `unusable-fix-accepts-idle-consumer`).
Probe matrix run in a scratch dir copying the script (spec-style workspace + `--advisory-file`): trailing
`+`, leading `+`, empty entry, `+` without spaces, consumer without `@version` (scoped or not), a
"workspace package" pseudo-consumer, missing `cannot use`, second version of a declared consumer,
importer direct dep, undeclared third parent, idle consumer → ALL exit 1. Only a correct list and a
duplicated entry pass. Workspace parents never contain `@`, expected always does → importer edges can
never be declared away. `dependentsOf` counts parents of ANY version of the affected package (over-counts, safe).

**First live entries:** GHSA-g3hv-75wg-m249 (minimatch, 5 consumers incl. PROD `@ts-morph/common@0.29.0`
via ts-morph → Permissions scanner, fixed globs joined with `findProjectRoot()`) and GHSA-3g3m-2fjr-6pw4
(glob, rimraf only, dev). Prod scope guarded by `audit-suppression-scope.spec.ts` `prodVia` — checks DIRECT
parents only (regex `^[└├]─[┬─] (\S+)` on pnpm 11 `why` output, asserts ≥1 parent so not vacuous). Residual
gap below bar: a second prod package reaching `@ts-morph/common@0.29.0` passes both guards.

**Starter lag:** nest-server-starter's `scripts/check-overrides.mjs` port still has the SINGLE-consumer
`parseResidual` (lastIndexOf '@' over the whole left side) — a copied ` + ` declaration there fails closed
("no <long string> in the tree"), never permissive. Re-review when the starter port is updated.

**How to apply:** when this guard changes again, re-run the probe matrix above against the new script and
each `unusable-fix-*` mutation (apply `find`→`replace` to a scratch copy); every case except the correct
list must stay exit 1.

Related: [[project-pnpm-overrides-propagation]], [[project-check-overrides-pnpm11-outage-shapes]]
