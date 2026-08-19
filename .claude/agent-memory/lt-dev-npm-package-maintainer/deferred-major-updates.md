---
name: deferred-major-updates
description: Updates deliberately NOT taken in nest-server and the reason each needs its own release (better-auth 1.7, graphql 17, graphql-upload 18, typescript 7)
metadata:
  type: project
---

# Deferred updates in `@lenne.tech/nest-server` (as of 2026-08-19, pre-11.36.0)

Each of these is a real, available update that was deliberately left in place. They are
deferred, not blocked — the constraint is release hygiene, not technical impossibility.

**Why:** this repo IS the framework. Whatever it pins becomes the pin every downstream
project inherits, so a breaking dependency move has to ship with its own migration guide
rather than riding along in an unrelated release.

**How to apply:** when a maintenance run reports these as "outstanding", do not treat it
as an oversight. Only take one if the run's explicit purpose is that migration.

| Package | Current | Available | Reason deferred |
|---|---|---|---|
| `better-auth` + `@better-auth/passkey` | 1.6.26 | 1.7.0 | 16+ breaking changes. Load-bearing one: **accounts now require `Account.issuer`**, needing an account-identity backfill before deployment in EVERY consuming project. Also `experimental.joins` → `advanced.database.joins`, SCIM replaced wholesale, `UpstreamProvider.verifyIdToken` removed, MCP plugin split into `@better-auth/mcp`. The two packages move in lock-step (`@better-auth/passkey@1.7.0` peers `better-auth@^1.7.0`). Verified 2026-08-19: no breaking change to the `password.hash`/`verify` config this framework installs — so the scrypt pair is NOT the blocker; the data migration is. |
| `graphql` | 16.14.0 | 17.0.2 | Ecosystem-wide major. `@nestjs/graphql@13.4.5` peers `^16.11.0 \|\| ^17.0.0`, so Nest itself is ready — the risk is the rest of the Apollo/upload chain. |
| `graphql-upload` | 15.0.2 | 18.0.0 | Import extension changed `.js` → `.mjs`; touches `src/core.module.ts`, both file resolvers, and `src/types/graphql-upload.d.ts`. |
| `typescript` | 5.9.3 | 7.0.2 | Skips "6". Ecosystem readiness across NestJS + ts-morph + oxlint unproven. |
| `pnpm` (`packageManager`) | 11.13.1 | 11.22.0 | **Never bump this from a maintenance run.** It is the single source of truth for the pnpm pin and has its own contract test (`tests/unit/pnpm-pin-contract.spec.ts`). Bump via `pnpm self-update` deliberately. |

Related: [[nest-server-override-status]]
