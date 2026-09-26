---
name: deferred-major-updates
description: Updates deliberately NOT taken in nest-server and why (NestJS 12, vitest 5, graphql 17, graphql-upload 18, typescript 7, dotenv 18, nodemailer 10, pnpm 12, better-auth lock-step)
metadata:
  type: project
---

# Deferred updates in `@lenne.tech/nest-server` (state 2026-09-26, 11.41.4 maintenance run)

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
| `@nestjs/*` family (common/core/platform-express/testing 11.2.6, apollo/graphql 13.4.5, swagger 11.4.7, jwt, mongoose, passport, schedule, terminus, cli, schematics) | 11.x line | 12.x (core 12.1.0) | NestJS major = package major. Only in-major bumps (11.2.x) are taken. |
| `vitest` + `@vitest/coverage-v8` | 4.1.11 | 5.0.1 (5.0.2 in cooldown) | Dev-only, but: `clearMocks` default flips to `true`, pool/worker IDs start at 1, `describe.sequential` removed. `scripts/check.mjs` AND `scripts/check-mutations.mjs` parse vitest's summary line; the latter runs only on the publish path, so `check` going green does not prove it. Take in its own change and run `check:mutations` too. |
| `graphql` | 16.14.2 | 17.0.2 | Ecosystem-wide major (consumer-visible dependency). `@nestjs/graphql@13.4.5` peers `^16.11.0 \|\| ^17.0.0`. |
| `graphql-upload` | 15.0.2 | 18.0.0 | Exports moved `.js` → `.mjs`: touches `src/core.module.ts` (`graphql-upload/graphqlUploadExpress.js`), `src/core/modules/file/core-file.resolver.ts` + `src/server/modules/file/file.resolver.ts` (`graphql-upload/GraphQLUpload.js`), `src/types/graphql-upload.d.ts`. |
| `dotenv` | 17.4.2 | 18.x | Runtime dependency major. |
| `nodemailer` | 9.1.1 | 10.x | Runtime dependency major (mail path). |
| `typescript` | 5.9.3 | 7.0.2 | Skips "6". Ecosystem readiness across NestJS + ts-morph + oxlint unproven. |
| `pnpm` (`packageManager`) | 11.13.1 | 11.27.1 / 12.6.0 | **Never bump from a maintenance run.** Single source of truth with its own contract test (`tests/unit/pnpm-pin-contract.spec.ts`). Bump via `pnpm self-update` deliberately. |
| `better-auth` + `@better-auth/core` + `@better-auth/passkey` | 1.7.1 (peer `>=1.7.1 <1.8.0`) | 1.7.6 | Wire-critical, move in LOCK-STEP across nest-server, nuxt-extensions and both starters. Coordinator instruction: never change their peer ranges or devDep versions in a maintenance run — report only. |

Taken since the previous version of this note (no longer deferred): better-auth 1.7 migration,
`@getbrevo/brevo` 6.x, `ts-morph` 28, `@compodoc/compodoc` 2.0.0, `ejs` 6, `@types/node` 26,
`unplugin-swc` 2.0.0 (only breaking change: dropped Node 18; taken 2026-09-26).

Related: [[nest-server-override-status]], [[nest-server-maintenance-gotchas]]
