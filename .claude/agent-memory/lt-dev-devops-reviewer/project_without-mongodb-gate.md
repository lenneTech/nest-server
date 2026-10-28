---
name: project-without-mongodb-gate
description: 12.1.0 (DEV-3833) MongoDB libraries became optional peers; how to prove the check:without-mongodb gates (dist + publish --package) without rebuilding dist or touching a database
metadata:
  type: project
---

Since DEV-3833 (branch `feat/db-agnostic`, reviewed 2026-10-28) `mongoose`, `@nestjs/mongoose` and `mongodb` are
devDependencies + OPTIONAL peers. Two gates: `check:without-mongodb` (`--dist`, in `check:raw`/`check:fix`/`check:naf`
after `check:manifest`, and build.yml after Build) and `--package` (publish.yml, before npm-publish: `pnpm pack`,
npm install into a temp project, fails if any of the three lands in node_modules, boots a PostgreSQL-only app).
The script creates/drops only `nest_server_ci_without_mongodb_<pid>` via the maintenance DB `nest_server_e2e`.

**Why:** the parent review forbids running `--package` (its `pnpm pack` runs `prepack` = `rimraf dist && nest build`,
which pulls dist away from parallel reviewers). The install half can be proven without that.

**How to apply (side-effect-free proof recipes):**
- Install half: `npm pack --ignore-scripts --pack-destination <scratch>` (uses existing dist, no rebuild), write the
  same package.json the script writes (framework `file:` + pg + typeorm + non-optional peers from devDependencies),
  `npm install --package-lock-only`. Exit 0 = no ERESOLVE; grep package-lock `packages` keys for
  `node_modules/(mongoose|mongodb|@nestjs/mongoose|bson)$`. Verified clean 2026-10-28 (408 packages, npm 11.6.2).
- Load half: scan `dist/**/*.{js,cjs,mjs}` static imports/requires against dependencies + peerDependencies + builtins.
  Only hit was a self-reference in migrate-cli (harmless). The `--dist` run proves boot with the hooks.
- better-auth 1.7.13 HARD-depends on `@better-auth/mongo-adapter` (and drizzle/kysely/prisma adapters), but every one
  of their DB peers is optional — so npm installs no mongodb. Re-check this when better-auth moves.
- pnpm 11.28.5 `pack`: last stdout line is the tarball path, ABSOLUTE when `--pack-destination` differs from cwd
  (`packProject()` in the dist). Output ~110 KB, well under execFileSync's 1 MB maxBuffer.
- A PreToolUse hook blocks ANY Bash command whose text contains `DROP DATABASE` (even a grep) — grep `-i drop`.
- This repo's `Dockerfile` header says it is for nest-server-STARTER projects; nothing builds it here, so its `--prod`
  install lacking mongoose for this repo's own src/server is not a finding. The starter declares mongoose +
  @nestjs/mongoose (deps) and mongodb (devDeps) itself; the core falls back to `mongoose.mongo` for the driver.

Related: [[project-postgres-test-infra]], [[project-infra-surface]].
