---
name: nest-server-dependency-shape
description: Why specific nest-server packages sit in dependencies vs devDependencies, and the version couplings that must move together (mongodb+mongoose, lockstep pins)
metadata:
  type: project
---

# nest-server dependency shape and couplings (verified 2026-09-26, AWS note 2026-10-03, lockstep 2026-10-29)

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
`@aws-sdk/lib-storage` joined in 11.41.7 (streamed S3 multipart uploads). **The three AWS
packages (client-s3, lib-storage, s3-request-presigner) move as ONE version** — lib-storage
peer-requires `client-s3 ^<its own version>`; their peer ranges (`>=3.1045.0 <4`) stay as they are.

**Coupling — mongodb + mongoose move together.** mongoose declares `mongodb` with a tilde
range (`9.9.3` → `~7.5`, `9.10.2` → `~7.6`); a direct `mongodb` outside it splits the tree
(ObjectId `instanceof` failures). Current (2026-10-17, DEV-3616): mongoose 9.11.2 (`~7.7`) + mongodb 7.7.0. Since DEV-3616 the consumer gate and the starter's `pnpm run update` raise a framework `dependencies` pin in EITHER consumer section, so the starter's mongodb devDep follows automatically; framework devDeps still raise only consumer devDeps (better-auth stays consumer-owned).

**Lockstep with upstream exact pins** (see [[nest-server-maintenance-gotchas]]):
`graphql-ws` = `@nestjs/graphql`'s pin, `ws` = its pin, `express` and `multer` = the `@nestjs/platform-express` pins.
State 2026-10-29 (12.1.0 run): @nestjs/graphql 14.1.0 -> graphql-ws 6.3.0, ws 8.22.0 (graphql-ws 6.4.1 exists, HELD);
platform-express 12.3.2 -> express 5.3.0, multer 2.5.0 (no override needed any more). graphql-upload 17.1.0 is a
runtime dependency (scalar + middleware must be ONE copy; consumers import `GraphQLUpload` from nest-server).

Related: [[deferred-major-updates]], [[nest-server-override-status]]
