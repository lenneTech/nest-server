---
name: project-infra-surface
description: nest-server is a library but DOES ship reference Docker infra (Dockerfile, docker-entrypoint.sh, .dockerignore, .env.example) that downstream projects copy — plus JS/TS build tooling
metadata:
  type: project
---

**CORRECTED 2026-07-22** — an earlier version of this memory claimed "no Docker/compose/CI-YAML infra". That is WRONG. Verify with `ls` before trusting any inventory here.

`@lenne.tech/nest-server` is a published **framework library**, but it ALSO ships **reference infrastructure** that `nest-server-starter` and consumer projects copy and adapt:

- `Dockerfile` — 3-stage (deps/builder/runner), `node:24-alpine` **digest-pinned**, non-root `nodejs:1001`, `HEALTHCHECK` on `GET /health-check`, `EXPOSE 3000`, `ARG API_DIR` for standalone-vs-monorepo builds.
- `docker-entrypoint.sh` — migrations then `exec node …/main.js`. **`exec` ⇒ node becomes PID 1.**
- `.dockerignore`, `.env.example` (`.env` + `.env.*` gitignored; `.env.example` tracked).
- `.github/workflows/{build,publish}.yml`.

**Deployment shape lives elsewhere:** there is NO compose file in this repo. The real one is
`lt-monorepo/docker-compose.yml` (mongo + api + app, healthchecks, `depends_on: service_healthy`,
`restart: unless-stopped`, no host port for mongo). Always read it when judging runtime behaviour —
this repo's Dockerfile alone does not show the deployed configuration.

**Known infra gaps in the reference stack (verified 2026-07-22, still open):**
- **No memory limit anywhere** — not in the Dockerfile, not in the monorepo compose (no
  `deploy.resources.limits.memory` / `mem_limit` on api, app or mongo).
- **No `NODE_OPTIONS` / heap ceiling in production** — it exists only in `nodemon.json` (dev).
  Note V8's default already lands ~4 GB on a ≥16 GB host, so `--max-old-space-size=4096` is a
  measured no-op there; V8 is cgroup-blind, so the value only matters against a container limit.
- **`enableShutdownHooks()` is never called** anywhere in the repo — only mentioned in comments.
  Combined with node-at-PID-1 this governs signal behaviour; see [[project-pid1-signal-contract]].
- `docker-entrypoint.sh` here has **drifted** from the starter's (which is best-effort, layout-aware,
  seam-injected and unit-tested via `tests/unit/docker-entrypoint.spec.ts`). Diff both before judging.
  The starter deliberately lets a FAILED migration continue to server start; this repo's `set -e` copy aborts.
- This repo's entrypoint hardcodes `dist/src/main.js`, but this repo's own build emits `dist/main.js`
  (`start:prod`). The path is correct for the **starter** layout only.

**Other (non-Docker) review surface:** `scripts/check.mjs`, `vitest.config.ts` + `vitest-e2e.config.ts`,
`pnpm-workspace.yaml` `overrides:` (targets must be fixed versions; moved out of `package.json` in the
pnpm 11 upgrade), `bin/migrate.js` (3-layout resolver).

**CI reality:** both workflows run `pnpm run prepublishOnly` (= `lint && test:ci`) + `pnpm run build`.
**`pnpm audit` is NOT in CI** — it lives only in the maintainer-run `check`/`check:raw` chain. So
security overrides are validated locally, never by the pipeline. No coverage upload, no permissions gate.

See [[feedback-review-uncommitted-worktree]] for how these reviews are requested.
