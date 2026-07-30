---
name: project-infra-surface
description: nest-server is a library but DOES ship reference Docker infra (Dockerfile, docker-entrypoint.sh, .dockerignore, .env.example) that downstream projects copy — plus JS/TS build tooling and a blocking pnpm audit CI gate
metadata:
  type: project
---

**CORRECTED 2026-07-22, RE-VERIFIED 2026-07-30** — an early version claimed "no Docker/compose/CI-YAML
infra" (wrong), and the 2026-07-22 version's "known gaps" list is now largely stale (see below).
Verify with `ls` / `grep` before trusting any inventory here.

`@lenne.tech/nest-server` is a published **framework library**, but it ALSO ships **reference
infrastructure** that `nest-server-starter` and consumer projects copy and adapt:

- `Dockerfile` — 3-stage (deps/builder/runner), `node:24-alpine` **digest-pinned**, non-root
  `nodejs:1001`, `HEALTHCHECK` on `GET /health-check`, `EXPOSE 3000`, `ARG API_DIR` for
  standalone-vs-monorepo builds, **`tini` as PID 1**.
- `docker-entrypoint.sh` — migrations, then `exec $SERVER_CMD`.
- `.dockerignore`, `.env.example` (`.env` + `.env.*` gitignored AND dockerignored; `.env.example` tracked).
- `.github/workflows/{build,publish}.yml`.

**Deployment shape lives elsewhere:** there is NO compose file in this repo. The real one is
`lt-monorepo/docker-compose.yml` (mongo + api + app, healthchecks, `depends_on: service_healthy`,
`restart: unless-stopped`, no host port for mongo). Always read it when judging runtime behaviour —
this repo's Dockerfile alone does not show the deployed configuration.

**Fixed since the 2026-07-22 snapshot (do NOT re-report these as gaps):**
- **`tini` IS now PID 1** (`RUN apk add --no-cache tini`, `ENTRYPOINT ["/sbin/tini", "--", …]`) and
  **`server.enableShutdownHooks()` IS now called** (`src/main.ts:124`). Both landed in 11.32.0
  (commit d0e56d1). This supersedes the old [[project-pid1-signal-contract]] analysis.
- **The entrypoint no longer hardcodes a main.js path** — it probes `$DIST/src/main.js` then
  `$DIST/main.js` and errors explicitly if neither exists, so it is correct for BOTH this repo's
  layout (`dist/main.js`) and the starter's (`dist/src/main.js`).
- **`pnpm audit` IS in CI** — `.github/workflows/build.yml` step "Audit dependencies", **blocking**
  (no `continue-on-error`). It runs on every branch push. `publish.yml` still does NOT audit.

**Still-open infra gaps (verified 2026-07-30):**
- **No memory limit anywhere** — not in the Dockerfile, not in the monorepo compose.
- **No production `NODE_OPTIONS` heap ceiling — and that is now DELIBERATE**, documented in
  `docker-entrypoint.sh` (pinning a literal disables Node's cgroup-aware auto-sizing, so the cgroup
  OOM-killer fires before V8's graceful FATAL). Do not "fix" this.
- **No `docker-entrypoint` unit test in this repo** — only `tests/unit/pnpm-pin-contract.spec.ts`.
  The starter has `tests/unit/docker-entrypoint.spec.ts`; diff both before judging.
  The starter deliberately lets a FAILED migration continue; this repo aborts by default
  (`MIGRATE_FAILURE_POLICY=warn` opts out).
- No coverage upload, no `lt server permissions` gate (the scanner targets consumer projects).

**Other (non-Docker) review surface:** `scripts/check.mjs`, `vitest.config.ts` + `vitest-e2e.config.ts`,
`pnpm-workspace.yaml` (see [[project-pnpm-audit-and-overrides]] — non-obvious pnpm 11 mechanics),
`bin/migrate.js` (3-layout resolver).

See [[feedback-review-uncommitted-worktree]] for how these reviews are requested.
