---
name: nest-server-override-status
description: Where nest-server pnpm overrides live, why a range-floored key does NOT prevent downgrades, the two-fresh-resolve test, and the current state — since 2026-10-24 (12.0.0) only TWO entries (utils + multer, both on NestJS 12 exact pins); inert entries are removed, not kept as insurance
metadata:
  type: project
---

# nest-server override status

**Overrides live in `pnpm-workspace.yaml` (`overrides:`), NOT `package.json`.** pnpm 11
stopped reading the `pnpm` field. `allowBuilds`, `auditConfig.ignoreGhsas`,
`minimumReleaseAge`/`minimumReleaseAgeExclude`, `peerDependencyRules`, `nodeLinker` are
all there too.

**Owner rule since 2026-10-24: an entry that changes nothing goes.** Kai: "Nicht mehr verwendete
bitte entfernen (alles soll so sauber wie möglich sein)". "Cheap insurance against a parent
re-pinning downwards" is NOT a reason to keep an entry — `pnpm audit` and `check:overrides` run in
every `check` and report such a regression the day it happens. Each surviving entry states WHY it is
load-bearing (advisory + upstream exact pin) and its removal condition.

## A range-floored key does NOT make an entry downgrade-proof

An override key is matched against the **requested range a parent declares**, not against
the version that would resolve. A key like `'hono@>=4.0.0 <4.12.34'` still fires on the
SDK's `^4.11.4` and pins the whole spec to the target. Flooring the key bounds the blast
radius (no major drag); only a target at the latest release in the major prevents a
hold-back. Every run: compare each target to `npm view <pkg> time --json` (newest in major
that clears the 1440-min hold-back).

**Exception — do NOT widen a key onto an upstream EXACT pin FOR NO ADVISORY.** js-yaml 5.x:
`@nestjs/swagger` 11.4.7 exact-pins 5.3.0; on 2026-09-26 key `<5.2.2` deliberately left it
alone. **That flipped on 2026-10-01:** GHSA-r3ph-w7gj-g6xm (published 2026-09-29, fixed 5.4.1)
covers 5.3.0, so the key was widened to `'js-yaml@>=5.0.0 <5.4.2': '5.4.2'` and now FIRES on
the exact pin on purpose. The rule is "no advisory, no override of an upstream pin" — an
advisory is exactly the reason to do it. `check:overrides` reports the pre-raise state as
NOT MATCHING (selector does not reach `.>@nestjs/swagger>js-yaml`), not as TOO LOW.
Consumers carry 5.3.0 until they add the same entry: swagger is a runtime `dependency`.

## Testing load-bearing vs inert: two FRESH resolves

In a scratch dir, copy `package.json` + `pnpm-workspace.yaml` twice (one with the
`overrides:` block stripped), `pnpm install --lockfile-only --ignore-scripts` each, diff the
resolved versions, and bulk-audit BOTH lockfiles. Diffing against the committed lockfile
proves nothing. Lockfile keys: `  pkg@1.2.3:`, scoped ones quoted.

## `check:overrides` UNUSED means "package absent from the lockfile"

So an entry whose package is still in the tree (e.g. multer, pulled directly) can never be
reported UNUSED even when the entry itself fires on nothing. Under the coordinator's rule
"remove only if UNUSED + no lockfile change", such an entry gets RAISED in lockstep instead.

## Current state (2026-10-24, nest-server 12.0.0): two entries

- `'@graphql-tools/utils@>=12.0.0 <12.1.0': '12.1.0'` — GHSA-c4qx-w738-7hr3 (high, <=12.0.1); @nestjs/graphql
  14.0.3 exact-pins 12.0.1. Also keeps one copy (Apollo path requests `^12.1.0`). Raise key + target with each
  new 12.x.
- `'multer@>=2.0.0 <2.5.0': '2.5.0'` — GHSA-q7qp-rjg7-q26m (high); @nestjs/platform-express 12.2.0 exact-pins
  2.4.0. Target in lockstep with the direct `multer`.

Re-verified 2026-10-27 with the final dependency set (two fresh resolves): without the block, utils 12.0.1 and
multer 2.4.0 return (plus a second `@whatwg-node/promise-helpers` 1.3.2) — both still load-bearing, both targets
still the newest in their line, nothing to raise.

Removed on 2026-10-24 after two fresh resolves (full former block vs. only these two): axios, body-parser,
brace-expansion x3, fast-uri, hono, ip-address, js-yaml x2, minimatch, nanoid, postcss, qs, undici, ws. Same
audit (0), same peers check, same package set — except minimatch, which forced minimatch-9 requesters ACROSS
A MAJOR onto 10.2.6 (9.0.9 / brace-expansion 2.1.7 / balanced-match 1.0.2 return without it, all patched):
removed because crossing a major for a transitive is the shape the rules forbid. Also removed: allowBuilds
`@nestjs/core` + `@compodoc/compodoc` (no install script any more), and `peerDependencyRules.allowedVersions
'@apollo/server'` (nothing conflicts). The full per-run history (2026-09-26 … 2026-10-24) is in git
(`git log -p .claude/agent-memory/lt-dev-npm-package-maintainer/nest-server-override-status.md`).

## Lessons from the 2026-10-24 cleanup

- **Run the fresh-resolve comparison with the FINAL dependency set.** The first comparison ran while
  graphql-upload was on 17.1.0 (peers `@types/express ^4 || ^5`), so `allowedVersions '@types/express': '5'`
  looked unused. graphql-upload went back to 15.0.2 (peers `^4.0.29`) and `pnpm peers check` failed until
  the rule was restored. Re-check every rule after the last version change of the run.
- **Removing an `allowBuilds` entry leaves stale state in `node_modules/.modules.yaml`** (`ignoredBuilds`):
  the next `pnpm install` fails with ERR_PNPM_IGNORED_BUILDS naming packages that HAVE no install script
  (verified on the published tarballs). A fresh install from the same lockfile passes. Fix locally with
  `rm -rf node_modules && pnpm install --frozen-lockfile`; CI is unaffected (always fresh).
- `pnpm update --depth Infinity` (no package names) refreshes every transitive within its range and leaves
  exact direct pins alone — safe here; it moved ~100 transitive versions (kysely 0.28.17 -> 0.29.7 among
  them) with nothing red. `git diff --stat package.json` afterwards shows the cumulative diff vs HEAD, not
  what the update did — check for `^`/`~` instead of reading the stat.

Related: [[deferred-major-updates]], [[nest-server-maintenance-gotchas]], [[pnpm11-override-and-check-gotchas]]
