---
name: deferred-major-updates
description: Updates deliberately NOT taken in nest-server and why (NestJS 12, vitest 5, graphql 17, graphql-upload 18, typescript 7, dotenv 18, pnpm 12, better-auth lock-step); nodemailer 10 TAKEN in 11.41.5 as a security exception
metadata:
  type: project
---

# Deferred updates in `@lenne.tech/nest-server` (state 2026-10-01, 11.41.5 maintenance run)

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
`| X.default` fixes it (`MailTransportOptions`). `@types/nodemailer` 8.0.2 is KEPT (orchestrator
rule: keep unless it conflicts) — `tsc --explainFiles` loads none of its files any more, so it
is dead weight and a removal candidate for a minor. The starter's BARE `nodemailer: 9.1.1`
override must move to 10.0.13 with it (see [[starter-downstream-maintenance]]).

Each of these is a real, available update that was deliberately left in place. Deferred,
not blocked — the constraint is release hygiene, not technical impossibility.

**Why:** this repo IS the framework. Whatever it pins becomes the pin every downstream
project inherits, so a breaking dependency move ships with its own migration guide rather
than riding along in an unrelated release. The package MAJOR mirrors NestJS, so no
`dependencies`/`peerDependencies` major lands in a PATCH or MINOR maintenance run.

**How to apply:** when a run reports these as "outstanding", do not treat it as an
oversight. Only take one if the run's explicit purpose is that migration.

| Package | Current | Available | Reason deferred |
|---|---|---|---|
| `@nestjs/*` family (common/core/platform-express/testing 11.2.6, apollo/graphql 13.4.5, swagger 11.4.7, jwt, mongoose, passport, schedule, terminus, cli, schematics) | 11.x line | 12.x (core 12.1.1, 12.1.2 in cooldown 2026-10-01) | NestJS major = package major. Only in-major bumps (11.2.x) are taken. |
| `vitest` + `@vitest/coverage-v8` | 4.1.11 | 5.0.2 (5.0.3 in cooldown 2026-10-01) | Dev-only, but: `clearMocks` default flips to `true`, pool/worker IDs start at 1, `describe.sequential` removed. `scripts/check.mjs` AND `scripts/check-mutations.mjs` parse vitest's summary line; the latter runs only on the publish path, so `check` going green does not prove it. Take in its own change and run `check:mutations` too. |
| `graphql` | 16.14.2 | 17.0.2 | Ecosystem-wide major (consumer-visible dependency). `@nestjs/graphql@13.4.5` peers `^16.11.0 \|\| ^17.0.0`. |
| `graphql-upload` | 15.0.2 | 18.0.0 | Exports moved `.js` → `.mjs`: touches `src/core.module.ts` (`graphql-upload/graphqlUploadExpress.js`), `src/core/modules/file/core-file.resolver.ts` + `src/server/modules/file/file.resolver.ts` (`graphql-upload/GraphQLUpload.js`), `src/types/graphql-upload.d.ts`. |
| `dotenv` | 17.4.2 | 18.0.4 | Runtime dependency major. |
| `ws` / `graphql-ws` | 8.21.3 / 6.2.1 | 8.22.0 / 6.3.0 | Not majors, but LOCKSTEP with `@nestjs/graphql` 13.4.5's exact pins (newest 13.x). Bumping alone puts a second copy into every consumer tree. |
| `mongodb` | 7.6.0 | 7.7.0 | mongoose 9.10.3 still declares `~7.6`; 7.6.0 is the only 7.6.x. Move only with a mongoose that declares `~7.7`. |
| `typescript` | 5.9.3 | 7.0.2 | Skips "6". Ecosystem readiness across NestJS + ts-morph + oxlint unproven. |
| `pnpm` (`packageManager`) | 11.13.1 | 11.28.2 / 12.8.1 | **Never bump from a maintenance run.** Single source of truth with its own contract test (`tests/unit/pnpm-pin-contract.spec.ts`). Bump via `pnpm self-update` deliberately. |
| `better-auth` + `@better-auth/core` + `@better-auth/passkey` | 1.7.1 (peer `>=1.7.1 <1.8.0`) | 1.7.6 (1.7.7 in cooldown, 2026-10-01) | Wire-critical, move in LOCK-STEP across nest-server, nuxt-extensions and both starters. Coordinator instruction: never change their peer ranges or devDep versions in a maintenance run — report only. |

Taken since the previous version of this note (no longer deferred): better-auth 1.7 migration,
`@getbrevo/brevo` 6.x, `ts-morph` 28, `@compodoc/compodoc` 2.0.0, `ejs` 6, `@types/node` 26,
`unplugin-swc` 2.0.0 (only breaking change: dropped Node 18; taken 2026-09-26), `nodemailer` 10.0.13
(security exception, 11.41.5 — see the section at the top).

Related: [[nest-server-override-status]], [[nest-server-maintenance-gotchas]]
