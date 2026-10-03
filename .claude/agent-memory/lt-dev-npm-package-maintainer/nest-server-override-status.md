---
name: nest-server-override-status
description: Where nest-server's pnpm overrides live, why a range-floored key does NOT prevent downgrades, how to test load-bearing vs inert honestly, and the per-entry status as of 2026-10-03
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

## Status 2026-10-01 (11.41.5 run, 18 entries, none removed)

Raised: js-yaml 5.x (now LOAD-BEARING, see above), browserslist 4.29.1 -> 4.29.3 and hono
4.13.9 -> 4.13.11 (downgrade locks again — both packages ship patches weekly, so expect these
two every run). Two fresh resolves after the raise: WITH vs WITHOUT differs only in js-yaml
(5.3.0 returns) and the minimatch design (9.0.9 + brace-expansion 2.1.7 return). Every other
target was already the newest mature release in its major.
`@xhmikosr/decompress` (critical GHSA-hrh2-vp3x-79xf, fixed 11.1.4) needed NO override: the
lockfile was just stale (downloader requests `^11.1.1`). `pnpm update --depth Infinity
@xhmikosr/decompress` fixed it, then `@xhmikosr/decompress-tar` needed the same to drop a
stale 9.0.1 copy. The starter has a key `'@xhmikosr/decompress@>=11.0.0 <11.1.3': 11.1.4`,
which fires on the caret request and already delivers 11.1.4.

## Status 2026-10-03 (11.41.7 run, 18 entries, none removed)

Raised (key + target together, pure hold-backs, no new advisory): ip-address 10.7.2 -> 10.7.3,
hono 4.13.11 -> 4.13.12 — hono for the THIRD run in a row, so treat it as a standing item.
`ws` trailed 8.22.0 but stayed at 8.21.3: lockstep with the direct `ws` and `@nestjs/graphql`
13.4.5's exact pin, and two fresh resolves showed ws identical with and without the block (no
caret parent exists), so it holds nothing back. WITH vs WITHOUT now differs ONLY in js-yaml 5.x
(5.3.0 returns) and the minimatch design (9.0.9 + brace-expansion 2.1.7 return) — same as
2026-10-01. `auditConfig.ignoreGhsas` gained two entries in the 11.41.7 release work
(GHSA-ch52-4w7c-c8xp http-cache-semantics, GHSA-vfj7-8cjw-p6xm braces; no patched release
anywhere); `check:overrides` confirmed 2/2 still unfixed. A quick way to find hold-backs: parse
the `overrides:` block, and for each target list the newest same-major version older than
1440 min from `npm view <pkg> time --json` (script took ~20 s for 18 entries).

Shipped doc drift: the 2026-10-01 items (swagger js-yaml pin, platform-express multer pin) were
fixed in 11.41.6. `docs/security-overrides.md` line ~21 names "11.2.6, the version this framework
declares" — stale after the 11.41.7 bump to 11.2.7 (which still pins multer 2.4.0). Reported to the
author; check that line whenever `@nestjs/platform-express` moves.

Related: [[deferred-major-updates]], [[nest-server-maintenance-gotchas]], [[pnpm11-override-and-check-gotchas]]
