---
name: nest-server-override-status
description: Where nest-server's pnpm overrides live, why a range-floored key does NOT prevent downgrades, and how to test load-bearing vs inert honestly
metadata:
  type: project
---

# nest-server override status

**Overrides live in `pnpm-workspace.yaml` (`overrides:`), NOT `package.json`.** pnpm 11
stopped reading the `pnpm` field. `allowBuilds`, `auditConfig.ignoreGhsas`,
`minimumReleaseAge`/`minimumReleaseAgeExclude`, `peerDependencyRules`, `nodeLinker` are
all there too.

**Why this matters:** the file's own header block tracks each entry as LOAD-BEARING or
INERT, and that classification is part of the contract — an entry whose status changed
but whose comment still claims the old status is worse than no comment, because the next
maintainer trusts it.

## A range-floored key does NOT make an entry downgrade-proof (corrected 2026-08-22)

An earlier version of this memory — and the workspace file's own hono note — claimed a
**range-floored** key (one that stops below its target, e.g. `'hono@>=4.0.0 <4.12.34':
'4.12.34'`) "can only lift a vulnerable version up, never drag a newer patch down; safe to
keep forever". **That is false.**

An override key is matched against the **requested range a parent declares**, not against
the version that would resolve. The MCP SDK declares `hono: ^4.11.4`, which *intersects*
`<4.12.34`, so the floored key matched and replaced the whole spec — pinning hono at
4.12.34 while a clean resolve gave 4.13.3. The 2026-08-22 run found three entries doing
this: `axios` (1.18.1 vs 1.19.0), `ip-address` (10.3.1 vs 10.5.0), `hono`.

Flooring the key still matters — it bounds the blast radius, so the entry cannot drag a
future major across. But the only thing that prevents a hold-back is **keeping the target
at the latest release in the major**.

**How to apply:** every run, check each target against `npm view <pkg> versions` and raise
the target *and* the key upper bound together. A green `pnpm audit` will NOT reveal this —
the pinned version is patched, just stale.

## Testing load-bearing vs inert: use two FRESH resolves

Comparing against the committed lockfile is worthless — it already carries the pinned
versions, so overrides look inert and unrelated fresh-resolve drift looks load-bearing
(this produced a wrong answer for `ws`, `axios`, `ip-address` and `hono` on the first
attempt 2026-08-22). Instead, in a scratch dir, copy `package.json` +
`pnpm-workspace.yaml` twice — once with the `overrides:` block, once with it stripped —
run `pnpm install --lockfile-only --ignore-scripts` in each, and diff the resolved
versions. Takes seconds.

Lockfile keys are `  pkg@1.2.3:` (no leading slash) and scoped ones are quoted
(`  '@hono/node-server@2.0.11':`) — a grep that misses the quotes reports a scoped package
as absent.

## Status 2026-08-22 (15 entries, was 16)

LOAD-BEARING: `brace-expansion` (2.x returns without it), `minimatch` (9.0.9 returns),
`hono`, `axios`, `ip-address`.
INERT but kept as floored insurance: `ws`, `js-yaml` x2, `fast-uri`, `nanoid`, `postcss`,
`undici`, `body-parser`.

**REMOVED `@hono/node-server@<2.0.10` → its own documented removal condition was met:**
SDK 1.30.0 now declares `^1.19.9 || ^2.0.5` (it used to declare `^1.19.9` alone), and a
fresh resolve without the override picks 2.1.1 — above the 2.0.10 that fixes
GHSA-9mqv-5hh9-4cgg. Audit stayed clean after removal. The old comment's "regresses to
1.19.14" was stale.

Related: [[deferred-major-updates]], [[nest-server-maintenance-gotchas]]
