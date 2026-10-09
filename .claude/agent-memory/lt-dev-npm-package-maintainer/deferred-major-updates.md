---
name: deferred-major-updates
description: Updates deliberately NOT taken in nest-server and why, last run 2026-10-09 (NestJS 12 incl. @nestjs/schedule 12 + apollo/graphql 14, vitest 5, graphql 17, graphql-upload 18, typescript 7, dotenv 18, undici 8, pnpm 12, better-auth lock-step, ws/graphql-ws lockstep, mongoose 9.11 + mongodb 7.7 cross-repo, oxfmt 0.72); nodemailer 10 TAKEN in 11.41.5 as a security exception
metadata:
  type: project
---

# Deferred updates in `@lenne.tech/nest-server` (state 2026-10-04, 11.42.1 maintenance run)

## nodemailer 10 was TAKEN in 11.41.5 — a security exception to "no runtime major in a patch"

Five advisories published 2026-09-28..30 cover 9.1.1 (GHSA-v53p-9fqp-m79j high,
GHSA-prgh-xp8r-p3m5 high, GHSA-6vj9-mwq6-2f5v, GHSA-8vvx-rff5-p5rq, GHSA-g57g-f23g-4646
moderate) and are fixed ONLY in 10.0.x — 9.1.1 is the last 9.x. The orchestrator granted the
exception (only stated breaking change in 10.0.0: Node >= 20; nothing below 10.0.12, which
carries the CJS/types fixes). Taken: 9.1.1 -> 10.0.13. **Why this matters next time:** a
security advisory with no in-major fix is the one case where the patch-run rule bends — find
it at the START of a run (`pnpm audit` before anything else) and surface it, because the
orchestrator has to decide it, not the maintainer.
**What it cost:** one lockfile entry (nodemailer has no deps), audit 0, and a six-line SOURCE
edit in `src/core/common/interfaces/server-options.interface.ts`: nodemailer 10 ships its own
declarations via `typesVersions` (`lib/*` -> `dist/cjs/*/index.d.ts`), which node10
resolution honours and which SHADOW `@types/nodemailer`. Each transport is now
`export default class` + module-level `Options` alias instead of `export =` + merged
namespace, so `import type * as X` makes `| X` (the instance type) a namespace error;
`| X.default` fixes it (`MailTransportOptions`). `@types/nodemailer` was dead weight after that and
was DROPPED in 11.41.6. The starter's BARE `nodemailer: 9.1.1`
override must move to 10.0.13 with it (see [[starter-downstream-maintenance]]).

Each of these is a real, available update that was deliberately left in place. Deferred,
not blocked — the constraint is release hygiene, not technical impossibility.

**Why:** this repo IS the framework. Whatever it pins becomes the pin every downstream
project inherits, so a breaking dependency move ships with its own migration guide rather
than riding along in an unrelated release. The package MAJOR mirrors NestJS, so no
`dependencies`/`peerDependencies` major lands in a PATCH or MINOR maintenance run.

**How to apply:** when a run reports these as "outstanding", do not treat it as an
oversight. Only take one if the run's explicit purpose is that migration.

| Package | Current | Available (2026-10-03) | Reason deferred |
|---|---|---|---|
| `@nestjs/*` family (common/core/platform-express/testing 11.2.7, apollo/graphql 13.4.5, swagger 11.4.7, jwt 11.0.2, mongoose 11.0.4, passport 11.0.5, schedule 6.1.3, terminus 11.1.1, cli 11.0.24, schematics 11.1.0) | 11.x line | 12.x (core 12.1.2; apollo/graphql 14.0.3; schedule jumps 6 -> 12.0.2 to align with NestJS 12) | NestJS major = package major. Only in-major bumps (11.2.x) are taken. Every other @nestjs package is already the newest of its NestJS-11 line. |
| `vitest` + `@vitest/coverage-v8` | 4.1.11 | 5.0.3 | Dev-only, but: `clearMocks` default flips to `true`, pool/worker IDs start at 1, `describe.sequential` removed. `scripts/check.mjs` AND `scripts/check-mutations.mjs` parse vitest's summary line; the latter runs only on the publish path, so `check` going green does not prove it. Take in its own change and run `check:mutations` too. |
| `graphql` | 16.14.2 | 17.0.2 | Ecosystem-wide major (consumer-visible dependency). `@nestjs/graphql@13.4.5` peers `^16.11.0 \|\| ^17.0.0`. |
| `graphql-upload` | 15.0.2 | 18.0.0 (18.0.1 in cooldown) | Exports moved `.js` -> `.mjs`: touches `src/core.module.ts` (`graphql-upload/graphqlUploadExpress.js`), `src/core/modules/file/core-file.resolver.ts` + `src/server/modules/file/file.resolver.ts` (`graphql-upload/GraphQLUpload.js`), `src/types/graphql-upload.d.ts`. |
| `dotenv` | 17.4.2 | 18.0.5 | Runtime dependency major. |
| `undici` | 7.30.0 | 8.11.2 | Runtime dependency major (direct since 11.42.0 for `outboundFetch()`; its agent must match the undici the helper's own `fetch` comes from). Also the override target `undici@>=7.0.0 <7.30.0` stays in 7.x. |
| `ws` / `graphql-ws` | 8.21.3 / 6.2.1 | 8.22.0 / 6.3.0 | Not majors, but LOCKSTEP with `@nestjs/graphql` 13.4.5's exact pins (still the newest 13.x on 2026-10-03). Bumping alone puts a second copy into every consumer tree. The `ws` override target stays with them (two fresh resolves: identical with/without, so it holds nothing back). |
| `mongodb` | 7.6.0 | 7.7.0 | mongoose 9.10.4 (taken 2026-10-04) still declares `~7.6`. Move only with a mongoose that declares `~7.7`. There is no 7.6.x patch beyond 7.6.0 (only nightlies). **mongoose 9.11.0 declares `~7.7`** — published 2026-10-05 16:49 UTC, in cooldown on 2026-10-06; take mongoose 9.11.0 + mongodb 7.7.0 TOGETHER next run (a minor of a runtime dep: read its changelog first). **TRIED AND REVERTED 2026-10-06 (11.42.7 run):** `check` green, but `check:consumer --fast` went 74/119 red — see [[starter-downstream-maintenance]] item 12. It is a CROSS-REPO move: the starter must raise its `mongodb` devDep to 7.7.0 in the same release (or check-consumer must align across sections), plus a migration-guide line. Not a maintenance-run bump. |
| `ejs` | 6.0.1 | 7.0.1 (2026-10-04) | Runtime major. Breaking: options-in-data (Express-2 compat) REMOVED, CLI argument parser reworked, browser bundle via conditional exports. Removing options-in-data is a hardening; check how `TemplateService` calls `renderFile` before taking it, in its own change. |
| `@graphql-tools/schema` / `merge` refresh | **TAKEN 2026-10-09** (repo owner decision) | 10.1.3 / 9.2.6 on the `@apollo/server` path | Was held because the new releases request `@graphql-tools/utils ^12.0.3` -> `@whatwg-node/promise-helpers` 2 (Node >=22.15). Resolved together: `engines.node` `>= 22.12` -> `>= 22.15`, override target 12.0.1 -> 12.0.3. `@nestjs/graphql` 13.4.5 still EXACT-pins schema 10.1.0 / merge 9.2.3, so both copies coexist — expected, they share the single utils 12.0.3 and the single graphql 16.14.2. Not a downgrade: the same split a fresh consumer resolve already had. |
| `typescript` | 5.9.3 | 7.0.2 | Skips "6". Ecosystem readiness across NestJS + ts-morph + oxlint unproven. |
| `pnpm` (`packageManager`) | 11.28.5 (raised by the ORCHESTRATOR on 2026-10-09, not by a maintenance run) | 12.9.1 (2026-10-06) | **Never bump from a maintenance run.** Single source of truth with its own contract test (`tests/unit/pnpm-pin-contract.spec.ts`). pnpm 12 is forbidden. On this machine `pnpm self-update` refuses under corepack; the orchestrator used `corepack use pnpm@11.28.5`. The FIRST install under 11.28.5 rewrites ~340 lockfile lines of optional-peer suffixes (`(supports-color@8.1.1)` on debug/@nestjs/common/express, `(uglify-js@…)` on webpack) with zero version movement — expect that churn in the starter too. |
| `better-auth` + `@better-auth/core` + `@better-auth/passkey` | 1.7.7 (peer `>=1.7.7 <1.8.0`) | 1.7.7 is still `latest` (2026-10-06); no 1.8 yet | Wire-critical, move in LOCK-STEP across nest-server, nuxt-extensions and both starters (peer ranges byte-identical in both frameworks). Coordinator instruction: never change their peer ranges or devDep versions in a maintenance run — report only. |

Taken since the previous version of this note (no longer deferred): better-auth 1.7 migration,
`@getbrevo/brevo` 6.x, `ts-morph` 28, `@compodoc/compodoc` 2.0.0, `ejs` 6, `@types/node` 26,
`unplugin-swc` 2.0.0 (only breaking change: dropped Node 18; taken 2026-09-26), `nodemailer` 10.0.13
(security exception, 11.41.5 — see the section at the top). 11.41.7 run (2026-10-03): @nestjs
common/core/platform-express/testing 11.2.6 -> 11.2.7, AWS SDK trio (client-s3, lib-storage,
s3-request-presigner) 3.1143.0 -> 3.1145.0 as ONE version (3.1146.0 was in cooldown), @swc/core,
@types/node, bullmq, vite patches. No code change needed for any of them.
11.42.1 run (2026-10-04): `@modelcontextprotocol/sdk` 1.31.0 -> 1.32.0 (client transports now follow
redirects same-origin only — the framework never builds a client transport, so only consumers who
do are affected), mongoose 9.10.3 -> 9.10.4, supertest 7.3.0 -> 7.3.1, AWS trio 3.1145.0 -> 3.1146.0.
No code change. In cooldown at run time: nodemailer 10.0.14 (mature 2026-10-04 13:45 UTC),
smtp-server 3.19.17 (2026-10-04 20:02 UTC) — take them next run.

11.42.4 run (2026-10-06): nodemailer 10.0.13 -> 10.0.14 (address-parser + DKIM linear-time fixes, no
breaking change), smtp-server 3.19.16 -> 3.19.17 (devDep). No code change. In cooldown: nodemailer
10.0.15 (mature 2026-10-06 10:10 UTC), mongoose 9.11.0 (16:49 UTC).

Related: [[nest-server-override-status]], [[nest-server-maintenance-gotchas]]

11.42.7 run (2026-10-06): `@modelcontextprotocol/sdk` 1.32.0 -> 1.32.1 (docs only), nodemailer 10.0.14 ->
10.0.15 (NodemailerError vs `@types/node` 26 typing fix), oxlint 1.86.0 -> 1.87.0 (0 diagnostics, same as
1.86). No code change. **Skipped: oxfmt 0.72.0** — reformats two SHIPPED READMEs
(`src/core/modules/better-auth/README.md`, `src/core/modules/hub/README.md`: list-continuation line
inside an inline code span gets indented, plus a final newline). Whitespace only, but `check` auto-fix
would write it into `src/` during a release run; take it in a run that may touch `src/`.
mongoose 9.11.0 + mongodb 7.7.0 tried and reverted (see the mongodb row).

11.42.8 run (2026-10-07): vite 8.3.2 -> 8.3.3 (devDep; dev-server `fs.serve` fixes, identical dependency
manifest). No code change. **oxfmt 0.72.0 still skipped** — re-verified read-only (scratch `npm i` +
`--check src/ scripts/`): the same two shipped READMEs, nothing else; no 0.72.1 yet. Still deferred:
mongoose 9.11.0 + mongodb 7.7.0 (cross-repo, no 9.10.5 / 7.6.x patch exists), ws 8.22.0 / graphql-ws
6.3.0 (@nestjs/graphql 13.4.5 is still the newest 13.x), @graphql-tools/utils 12.0.3 (engines). In
cooldown: AWS trio 3.1147.0 (matures 2026-10-07 ~23:00 UTC) — next run, as one version. Majors seen:
dotenv 18.0.6, graphql-upload 18.0.1 (now mature), everything else as in the table. A discovery script
reading registry `time` per direct dep + override target (newest mature in-major, pending, majors) ran in
~10 s and replaces `ncu`, which ignores `minimumReleaseAge`; check 0.x packages separately (a 0.x minor
is a semver major, so an in-major filter hides oxfmt).

Post-11.42.9 run (2026-10-09, pnpm pin already 11.28.5): nodemailer 10.0.15 -> 10.0.16 (address-parser
+ fetch cookie fixes), AWS trio 3.1146.0 -> 3.1147.0 as one version (3.1148.0 in cooldown until
2026-10-09 18:52 UTC). Baseline audit was RED: three handlebars advisories (GHSA-8r5x-fm3f-whwj +
GHSA-p8wg-vrv2-v86f critical, GHSA-xw65-4hp5-5hc7 moderate, fixed 4.7.10, dev-only via compodoc) —
a stale lock entry, compodoc requests `^4.7.9`, so `pnpm update --depth Infinity handlebars` fixed it
with NO override (moved exactly one name). No code change. Still deferred, same reasons: mongoose now
9.11.1 (`mongodb ~7.7`) + mongodb 7.7.0 — the starter still declares mongodb 7.6.0 as a DEVdependency
and `alignConsumerPins()` is still same-section only; oxfmt 0.72.0 (re-verified: still exactly the two
shipped READMEs, no 0.72.1); ws 8.22.0 / graphql-ws 6.3.0 (no @nestjs/graphql 13.4.6); utils 12.0.3.
**New wrinkle on @graphql-tools/utils:** a FRESH resolve already carries utils 12.0.3 +
@whatwg-node/promise-helpers 2 via `@apollo/server > @graphql-tools/schema ^10 (10.1.3) > merge 9.2.6`,
so every generated project has the Node >=22.15 floor regardless — the engines argument for holding the
override at 12.0.1 only protects THIS repo's sticky lock (schema 10.1.0 / merge 9.2.3). Reported to the
orchestrator as a release decision; **decided the same day: raise** (engines.node `>= 22.15`, target 12.0.3). In cooldown at run time: smtp-server 3.19.18 (08:38 UTC),
vite 8.3.4 (12:07 UTC), AWS 3.1148.0 (18:52 UTC). Gate: `check` 5198 tests / 244 files, 3m41s;
`check:consumer --fast` unit 347 + 1 skipped / e2e 119, no pins raised.
