---
name: starter-downstream-maintenance
description: Traps when running the downstream nest-server-starter maintenance step after a nest-server release (sync-packages AND check:consumer ignore overrides, bare lockstep overrides, exact-pin keys, stale lock copies, safe final gate with foreign WIP)
metadata:
  type: project
---

# nest-server-starter: the downstream step after a framework release (learned 2026-09-26, 11.41.4)

**1. `pnpm run update` (extras/sync-packages.mjs) bumps package.json, never the overrides.**
A BARE lockstep override (`multer: 2.3.0`) then silently forces the direct dependency back down:
package.json said multer 2.4.0, the lockfile held only 2.3.0. pnpm overrides apply to direct
deps too. **Why:** sync-packages only compares the `dependencies`/`devDependencies` sections.
**How to apply:** after every framework bump, grep the lockfile for each lockstep package
(`multer`, `nodemailer`, `@apollo/server`, `ws`) and compare with package.json + the framework's
declared version. Prefer the framework's ranged key form (`'multer@>=2.0.0 <2.4.0': 2.4.0`) —
it cannot drag a direct dep down.

**2. sync-packages also skips packages whose SECTION differs** (e.g. `mongodb` is a starter
devDep but a framework dependency). Align those by hand; mongodb must match mongoose's tilde.

**3. Do not widen a key onto an upstream EXACT pin.** picomatch: `@angular-devkit/core`
exact-pins the patched 4.0.4; raising the key to `<4.0.7` would override it for no advisory.
Keep the key, raise only the target. Check the no-override fresh resolve for extra versions
inside one major — those are the exact pins. Same rule as js-yaml in [[nest-server-override-status]].

**4. Stale lock copies after a framework bump:** `jose` (better-auth's peer stayed on the old
version next to the framework's new one), `semver` 7.x. Dedupe with a targeted
`pnpm update --depth Infinity <pkg>`; never swap in a fresh lockfile (~300 lines of unrelated
transitive drift). A leftover `@vitest/ui` entry keeps `fflate` in the starter lock although a
fresh resolve has neither — harmless, leave it.

**4b. `check:consumer` has the same blind spot as sync-packages (verified 2026-10-01, 11.41.5).**
Its `alignConsumerPins()` raises only `package.json` pins the starter already declares; the copy
keeps the starter's `pnpm-workspace.yaml` verbatim. So with the starter's bare
`nodemailer: 9.1.1` override, `pnpm run check:consumer -- --fast` passed while the copy RAN
nodemailer 9.1.1 and js-yaml 5.3.0 — green, and silent about the framework's nodemailer 10.
**How to apply:** run it with `--keep` and read the installed versions of every lockstep package
out of the kept copy; to prove the TARGET state, run it again with
`--starter=<scratch copy of the starter with the follow-up overrides applied>` (that run: 10.0.13
+ js-yaml 5.4.2, unit 252 / e2e 119 green, starter audit 0). Neither touches the real starter.

**5. Final gate with other sessions' uncommitted files in the tree:** `pnpm run check` auto-fixes
format+lint. Safe only after `format:check` and `lint` are proven clean; snapshot `shasum` of the
foreign files before and diff after. `spectaql:sync` rewrites `spectaql.yml` version — expected.

Related: [[pnpm11-override-and-check-gotchas]], [[deferred-major-updates]]
