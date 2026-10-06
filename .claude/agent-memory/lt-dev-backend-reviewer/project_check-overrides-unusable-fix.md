---
name: project_check-overrides-unusable-fix
description: check-overrides `unusableFixConsumers` (11.42.5) lockfile parsing — what its second-consumer check sees and misses in pnpm v9 lockfiles; read before re-reviewing that guard.
metadata:
  type: project
---

`scripts/check-overrides.mjs` gained `auditConfig.unusableFixConsumers` (11.42.5, written by a peer
session for lt-crm's simple-git via @nuxt/devtools case). Reviewed 2026-10-06; facts established by
running its parsers against the real lockfiles of nest-server and lt-crm:

- `dependentsOf()` scans only `snapshots:`. **`importers:` is never read**, so the project's own
  (or a workspace package's) direct dependency on the affected package is not a "second consumer":
  reproduced green run with `projects/api` depending on simple-git directly. Reported as High.
- pnpm lockfile v9 lists RESOLVED PEERS under the snapshot's `dependencies` / `optionalDependencies`
  (e.g. `acorn-import-phases@1.0.4(acorn@8.16.0)` -> `dependencies: acorn`; `@angular-devkit/core`
  -> `optionalDependencies: chokidar`). The guard's and package-management.md's claim "peer edges do
  not count" is therefore false — but that errs fail-closed (false RE-TEST), so it was dropped as
  below the bar. Same for: edges are version-agnostic (a parent of a PATCHED version also counts).
- `resolvedVersion()` prefix class includes `/`, so an unscoped name matches a scoped basename
  (`core` -> `@angular-devkit/core@19.2.24`). Also fail-closed in practice; not reported.
- lt-crm's real case parses correctly: simple-git 3.36.0, dependents `[@nuxt/devtools]`.

**How to apply:** when this guard is touched again, check whether the importer gap was fixed before
re-flagging; do not re-raise the fail-closed items as High.
