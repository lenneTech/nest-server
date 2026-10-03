---
name: starter-downstream-maintenance
description: Traps when running the downstream nest-server-starter maintenance step after a nest-server release (sync-packages AND check:consumer ignore overrides, bare lockstep overrides, exact-pin keys, stale lock copies, sticky optional peers, pnpm dedupe, safe final gate with foreign WIP)
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

**4c. A resolved OPTIONAL PEER never leaves the lockfile on its own (found 2026-10-01, 11.41.5).**
`@nestjs/websockets@11.1.28` sat in the starter lock from 2026-07-16 as the resolved optional
peer of `@nestjs/core` — absent from a fresh resolve AND from nest-server's own lock, one NestJS
minor behind the family, and LOADED at runtime (`NestApplication` optionalRequires its
`SocketModule`). `pnpm update --depth Infinity @nestjs/core` and `pnpm dedupe` both keep it.
**How to apply:** compare the repo lock with a fresh `--lockfile-only` resolve by package NAME
(not version — version drift is normal); a name only the repo has is a sticky optional peer.
Drop it net-zero in scratch: add `'<pkg>': '-'` to `overrides`, `--lockfile-only`, restore the
workspace file byte-identical, `--lockfile-only` again, copy the lock back, `pnpm install
--frozen-lockfile`. Side effect: ~95 lines of `(supports-color@5.5.0)` optional-peer annotation
churn in snapshot keys, no version change. **Why it matters beyond the starter:** `check:consumer`
copies the starter's `pnpm-lock.yaml` (SKIP_ENTRIES excludes only .git/node_modules/dist/…) and
installs `--no-frozen-lockfile`, so the framework's consumer gate inherited the stale peer too.
Generated projects do NOT (the lt CLI deletes the template's lockfile).
`pnpm dedupe` on its own is cheap here: it collapsed exactly four in-major duplicates
(`@xhmikosr/decompress-tar` 9.0.1, `fs-extra` 11.3.4, `tinyglobby` 0.2.15, `type-is` 2.0.1)
with zero other drift — try it in scratch every run.

**5. Final gate with other sessions' uncommitted files in the tree:** `pnpm run check` auto-fixes
format+lint. Safe only after `format:check` and `lint` are proven clean; snapshot `shasum` of the
foreign files before and diff after. `spectaql:sync` rewrites `spectaql.yml` version — expected.

**6. `@vitest/ui` was the starter's sticky optional peer — DROPPED 2026-10-03 (11.41.7 run).**
Item 4's "harmless, leave it" is superseded: same mechanism as 4c, and it was the only reason
`fflate` + `flatted` were in the lock (neither vitest config uses the UI or the html reporter).
Dropped net-zero (`'@vitest/ui': '-'` trick) — exactly 3 packages left, zero version movement.
The `fflate@<0.8.3` override is KEPT as a pre-emptive floor with a dated comment; it is now inert.
If `@vitest/ui` reappears in the starter lock, someone ran `vitest --ui` — fine, the floor catches it.

**7. `check:overrides` can never report UNUSED on a real lockfile (found 2026-10-03, both repos).**
`scripts/check-overrides.mjs` tests `(^|[/'"\s])<pkg>@` against the whole lockfile — but pnpm echoes
EVERY override into the lockfile's own top-level `overrides:` header (`  fflate@<0.8.3: 0.8.3`), so
the regex always matches its own echo. The guard spec's fixtures (`check-overrides.guard.spec.ts`
"overrides for packages that left the tree") use synthetic locks WITHOUT that header, so they pass.
Proven with fflate: absent from `packages:`/`snapshots:`, guard said "ok". Fix belongs in nest-server
first (scan only the `packages:` section), then port. Reported, not edited — maintenance runs do not
touch `scripts/`. **How to apply:** never read a quiet guard as "every override is live"; use
`lockdiff` on `packages:` keys (or `pnpm why`) instead.

**8. Starter state 2026-10-03 (11.41.7):** every direct dep is the newest mature release of its
major or framework-constrained (mongodb 7.7 blocked by mongoose `~7.6`; mongoose 9.10.4 / supertest
7.3.1 in cooldown AND framework-pinned lower; better-auth trio 1.7.7 held by lock-step).
Deferred majors (same reasons as [[deferred-major-updates]]): NestJS 12 family incl. @nestjs/cli 12,
@nestjs/schematics 12, @nestjs/mongoose 12, @nestjs/swagger 12, @nestjs/schedule 12, @nestjs/graphql
14; vitest + @vitest/coverage-v8 5; typescript 7; dotenv 18; graphql-upload 18. Overrides: hono,
ip-address and vite were downgrade locks (vite is a starter-only entry — track it against
nest-server's own `vite` devDependency). `pnpm dedupe` found nothing. Remaining in-major pairs
(@angular-devkit 19.2.24/27, rxjs 7.8.1/7.8.2, picomatch 4.0.4/4.0.7, …) are upstream exact pins.

Related: [[pnpm11-override-and-check-gotchas]], [[deferred-major-updates]]
