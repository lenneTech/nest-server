---
name: nest-server-dependency-shape
description: Why specific nest-server packages sit in dependencies vs devDependencies, and the version couplings that must move together (mongodb+mongoose, lockstep pins)
metadata:
  type: project
---

# nest-server dependency shape and couplings (verified 2026-09-26)

**Shape is a contract.** The lt CLI's `src/config/vendor-runtime-deps.json` mirrors which
section each package lives in, so a maintenance run never moves packages between
`dependencies` / `devDependencies` / `peerDependencies` (coordinator constraint; CLAUDE.md
"Consumption in downstream projects"). Report a mis-categorisation instead of fixing it.

Why some surprising entries are RUNTIME `dependencies`:
- `supertest`, `@types/supertest`, `json-to-graphql-query`, `graphql-ws`, `ws` — imported by
  `src/test/test.helper.ts`, which is exported via `src/index.ts`.
- `ts-morph` — `permissions-scanner.ts`. `jose` — `core-better-auth.service.ts`.
  `cron` — `core-cron-jobs.service.ts`.
- `@as-integrations/express5` — depcheck calls it unused, but `@nestjs/apollo` `loadPackage`s
  it at runtime; optional peer + `autoInstallPeers: false` → must stay direct.

Why some are devDependencies AND peers: `better-auth` family (consumer owns the version),
`ioredis`, `bullmq`, `@aws-sdk/*`, `@tus/s3-store` (optional peers; devDep copy for tests).

**Coupling — mongodb + mongoose move together.** mongoose declares `mongodb` with a tilde
range (`9.9.3` → `~7.5`, `9.10.2` → `~7.6`); a direct `mongodb` outside it splits the tree
(ObjectId `instanceof` failures). Current: mongoose 9.10.2 + mongodb 7.6.0.

**Lockstep with upstream exact pins** (see [[nest-server-maintenance-gotchas]]):
`graphql-ws` = `@nestjs/graphql`'s pin (6.2.1), `ws` = its pin (8.21.3), `multer` = the
`@nestjs/platform-express` pin (2.4.0 in 11.2.6) + the multer override target.

Related: [[deferred-major-updates]], [[nest-server-override-status]]
