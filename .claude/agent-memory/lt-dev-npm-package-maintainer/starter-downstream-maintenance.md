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

**7. `check:overrides` UNUSED detection — FIXED in 11.41.8 (both repos, verified 2026-10-04).**
Until then the guard matched `<pkg>@` against the whole lockfile, including pnpm's echo of every
override in the lockfile's top-level `overrides:` header, so UNUSED was unreachable. It now scans
from `packages:` on. In the starter it correctly warns `fflate@<0.8.3` (the documented pre-emptive
floor) — a WARN, exit 0, expected on every run. A NEW unused warning is a real finding.

**8. Starter state 2026-10-03 (11.41.7):** every direct dep is the newest mature release of its
major or framework-constrained (mongodb 7.7 blocked by mongoose `~7.6`; mongoose 9.10.4 / supertest
7.3.1 in cooldown AND framework-pinned lower; better-auth trio 1.7.7 held by lock-step).
Deferred majors (same reasons as [[deferred-major-updates]]): NestJS 12 family incl. @nestjs/cli 12,
@nestjs/schematics 12, @nestjs/mongoose 12, @nestjs/swagger 12, @nestjs/schedule 12, @nestjs/graphql
14; vitest + @vitest/coverage-v8 5; typescript 7; dotenv 18; graphql-upload 18. Overrides: hono,
ip-address and vite were downgrade locks (vite is a starter-only entry — track it against
nest-server's own `vite` devDependency). `pnpm dedupe` found nothing. Remaining in-major pairs
(@angular-devkit 19.2.24/27, rxjs 7.8.1/7.8.2, picomatch 4.0.4/4.0.7, …) are upstream exact pins.

**9. Starter state 2026-10-04 (starter 11.42.1, framework 11.42.1).** Only change needed after
`pnpm run update`: `supertest` 7.3.0 -> 7.3.1 (devDep here, runtime dep in the framework — the
section-mismatch blind spot of item 2, again; it left a second supertest copy). Every override target
was already the newest mature release of its major except `ws` 8.21.3 (lockstep, keep) and nodemailer
10.0.14 (in cooldown, above the framework's 10.0.13 — keep 10.0.13). WITH vs WITHOUT fresh resolves
differ only in js-yaml 5.x (load-bearing), minimatch 9 / brace-expansion 2 (design), ajv 8.18 and
uuid 14.0.1 (floors) — unchanged since 11.41.5. `pnpm dedupe`: nothing. No sticky optional peer
(`arch` vs `system-architecture` is ordinary `@xhmikosr/os-filter-obj` drift). Gate: 420 tests /
29 files, 1m50s total. The starter's own `.claude/agent-memory/.../MEMORY.md` is stale since
session 13 (11.41.5); starter notes have lived HERE since the 11.41.7 run.

**10. Port reservation is no longer needed in the starter (verified 2026-10-06).** Both specs that
used to `listen(0)` on the wildcard (`tests/modules/tus.e2e-spec.ts`, `file-graphql.e2e-spec.ts`) now
pass `'127.0.0.1'`; with seven VS Code squatters present the gate ran green without reserving.

**11. Starter run for framework 11.42.4 (2026-10-06) — what was non-obvious:**
- **Re-resolve a stale CHILD by updating its PARENT.** `pnpm update --depth Infinity source-map-js`
  left `postcss@8.5.28 > source-map-js 1.2.1` in the lock (both 1.2.1 and 1.2.2 present, audit high
  GHSA-68fv-2mgg-jv7q). `pnpm update --depth Infinity postcss` (scratch, `--lockfile-only`) moved
  exactly that edge and dropped 1.2.1 — 12-line diff, nothing else. No override needed: a fresh resolve
  lands on 1.2.2, and nest-server has no entry either.
- **Judge "unrelated movement" against HEAD, not the dirty tree.** The orchestrator's earlier targeted
  updates had flipped `@swc/cli`'s optional chokidar peer 4.0.3 -> 5.0.0 and shuffled
  `(supports-color@5.5.0)` annotations; they then rejected `pnpm dedupe` because it "moved chokidar
  5.0.0 -> 4.0.3". Against HEAD (and a fresh resolve, and the `peerDependencyRules` comment) 4.0.3 IS
  the original: dedupe gave 83 vs 105 changed lines and zero chokidar lines, with no version change.
  Diff every candidate lockfile against `git show HEAD:pnpm-lock.yaml` by package name+version.
- **nodemailer override raised to the lockstep 10.0.14** (key `<10.0.14`) — supersedes the earlier
  "no change needed" note: the entry's own comment requires target == framework's declared version,
  and a `^10` requester would otherwise get a second 10.0.13 copy. Tree unchanged by it.
- **http-cache-semantics 4.3.0 (2026-10-04) escapes GHSA-ch52-4w7c-c8xp's `<= 4.2.0` range WITHOUT
  fixing it** (max-stale code unchanged; maintainer disputes the report, issue #56; advisory-database
  #10139 open). Do not "close" the advisory by bumping to it. A fresh resolve takes 4.3.0, so the
  suppression is inert in generated projects; this lock stays on 4.2.0. Watch for the advisory being
  withdrawn — then `check:overrides` fails the suppression and it goes.
- Pending next run (cooldown on 2026-10-06): postcss 8.5.29 (mature 09:28 UTC, requests
  source-map-js ^1.2.2), nanoid 3.3.20 (09:44 UTC), js-yaml 5.4.3 (22:13 UTC); oxlint 1.87.0 / oxfmt
  0.72.0 (11:05 UTC — follow the framework's devDeps); mongoose 9.11.0 + mongodb 7.7.0 only with the
  framework. Gate: 420 tests / 29 files, `check` 52 s.

**12. A framework mongoose/mongodb move BREAKS check:consumer via the section mismatch (2026-10-06).**
Framework mongoose 9.10.4 -> 9.11.0 (`mongodb ~7.7`) + mongodb 7.6.0 -> 7.7.0: `check` green (5071),
but `check:consumer --fast` 74/119 red, 401s plus `[Better Auth] MongoAdapterError: Invalid id value`
(`serializeID`). Cause: `alignConsumerPins()` raised the starter mongoose (same section) but not its
`mongodb` DEVdependency, so `@better-auth/mongo-adapter` resolved mongodb 7.6.0 / bson 7.2.0 while
mongoose and nest-server ran 7.7.0 / bson 7.3.3: ObjectId identity split. Proven both ways: raising mongodb
to 7.7.0 in the kept copy turned user-rest 9/9 green; reverting the pair turned the gate 119/119.
**How to apply:** whenever a framework runtime dep moves that the starter ALSO declares (any section), run
`pnpm run check:consumer -- --fast --keep` inside the maintenance run. Plain `check` cannot see this,
and the publish workflow would block on it. The mongo pair needs the starter raised in the SAME release.
**13. smtp-server 3.19.17 exact-pins nodemailer 10.0.14** (dev-only). With the framework on 10.0.15 the
lock carries a nested second copy under smtp-server: harmless (test-only), no override (no advisory).
(Framework repo only — the starter has no smtp-server.)

**14. Starter run for framework 11.42.7 (2026-10-06) — what was non-obvious:**
- **Keep the starter's oxfmt on the FRAMEWORK's version even when it is drift-free here.** oxfmt
  0.72.0 reformatted nothing in the starter's own `src/`/`tests/` (72 files), but generated VENDOR-mode
  projects format the vendored `src/core/` with the template's oxfmt, and 0.72.0 is exactly the version
  that rewrites two core READMEs (the framework's reason to skip it). Move it when the framework does.
- **A RAISED override target moves on a plain `pnpm install`** (postcss 8.5.29, nanoid 3.3.20 landed
  without a targeted update; lock delta = 3 header lines + the two packages, nothing else). The
  stickiness in [[pnpm11-override-and-check-gotchas]] item 2 bites on REMOVED entries or keys that stop
  firing, where the old version still satisfies the parent range.
- **bson stays 7.2.0 in the starter lock** although a fresh resolve floats to 7.3.3 under mongodb 7.6.0;
  the framework's own lock is on 7.2.0 too, single copy either way. Do not "fix" it in isolation — the
  mongo pair moves cross-repo (item 12).
- WITH vs WITHOUT unchanged (graphql-tools 12.0.0 + js-yaml 5.3.0 return and audit vulnerable;
  minimatch 9 / brace-expansion 2 design; ajv 8.18 + uuid 14.0.1 floors). `pnpm dedupe`: nothing.
  Gate: 448 tests / 30 files, `check` 1m25s. Foreign e2e runs from other lt projects come and go —
  a short bounded `pgrep -f "[v]itest\.mjs"` wait was enough.
- Pending next run: js-yaml 5.4.3 (mature 2026-10-06 22:13 UTC; follow the framework's entry), vite
  8.3.3 (mature 2026-10-07 04:10 UTC; starter-only entry, track nest-server's vite devDep, 8.3.2 today),
  oxfmt 0.72.0 (only with the framework), mongoose 9.11.0 + mongodb 7.7.0 (only with the framework).

Related: [[pnpm11-override-and-check-gotchas]], [[deferred-major-updates]]
