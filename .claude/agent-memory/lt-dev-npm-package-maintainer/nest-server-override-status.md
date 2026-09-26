---
name: nest-server-override-status
description: Where nest-server's pnpm overrides live, why a range-floored key does NOT prevent downgrades, how to test load-bearing vs inert honestly, and the per-entry status as of 2026-09-26
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

## A range-floored key does NOT make an entry downgrade-proof

An override key is matched against the **requested range a parent declares**, not against
the version that would resolve. A key like `'hono@>=4.0.0 <4.12.34'` still fires on the
SDK's `^4.11.4` and pins the whole spec to the target. Flooring the key bounds the blast
radius (no major drag); only a target at the latest release in the major prevents a
hold-back. Every run: compare each target to `npm view <pkg> time --json` (newest in major
that clears the 1440-min hold-back).

**Exception — do NOT widen a key onto an upstream EXACT pin.** js-yaml 5.x: `@nestjs/swagger`
exact-pins 5.3.0; key `<5.2.2` does not touch it. Raising the key to `<5.4.2` would override
swagger's own pin for no advisory. Left alone deliberately (2026-09-26).

## Testing load-bearing vs inert: two FRESH resolves

In a scratch dir, copy `package.json` + `pnpm-workspace.yaml` twice (one with the
`overrides:` block stripped), `pnpm install --lockfile-only --ignore-scripts` each, diff the
resolved versions, and bulk-audit BOTH lockfiles. Diffing against the committed lockfile
proves nothing. Lockfile keys: `  pkg@1.2.3:`, scoped ones quoted.

## `check:overrides` UNUSED means "package absent from the lockfile"

So an entry whose package is still in the tree (e.g. multer, pulled directly) can never be
reported UNUSED even when the entry itself fires on nothing. Under the coordinator's rule
"remove only if UNUSED + no lockfile change", such an entry gets RAISED in lockstep instead.

## Status 2026-09-26 (18 entries, none removed)

Without the block, a fresh resolve has **zero** advisories (1069 versions) — no entry is
security-load-bearing in this repo after the 11.41.4 direct bumps. minimatch is the only
entry that still changes the tree (keeps 9.0.9 + brace-expansion 2.x out; both patched now).
Seven downgrade locks found and raised: axios 1.20.0, browserslist 4.29.1, brace-expansion
1.1.21 / 5.0.12 (2.x → 2.1.7 for consistency), fast-uri 3.1.8, hono 4.13.9, ip-address
10.7.2, undici 7.30.0. Also raised: nanoid 3.3.19, postcss 8.5.28, multer 2.4.0 (lockstep with
direct; inert since `@nestjs/platform-express@11.2.6` exact-pins 2.4.0, but mirrored for
consumers in `docs/security-overrides.md`). Unchanged: qs, ws, js-yaml x2, minimatch,
body-parser. After the raise, WITH == WITHOUT for every overridden package except the
minimatch design.

Shipped doc drift left for the author (outside a maintenance run's edit scope):
`docs/security-overrides.md` still says swagger pins js-yaml 5.2.1 (now 5.3.0) and
platform-express pins multer 2.2.0 "in every 11.2.x" (11.2.6 pins 2.4.0).

Related: [[deferred-major-updates]], [[nest-server-maintenance-gotchas]], [[pnpm11-override-and-check-gotchas]]
