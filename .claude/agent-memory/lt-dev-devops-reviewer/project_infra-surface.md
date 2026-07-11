---
name: project-infra-surface
description: nest-server has NO Docker/compose/CI-YAML infra — the DevOps review surface is JS/TS build tooling + pnpm override hygiene
metadata:
  type: project
---

`@lenne.tech/nest-server` is a published **framework library**, not a deployable app. It ships **no Dockerfile, no docker-compose, no .env, no .dockerignore, no GitLab CI**. So the DevOps-reviewer's Docker/Compose/Nuxt-SSR/.dockerignore phases are permanently **N/A** here.

**The actual infra review surface:**
- `scripts/check.mjs` — the local check pipeline (discovers each workspace's check chain, runs steps, prints metrics). Metric parsers (`parseVitest`, etc.) are unit-tested in `tests/unit/check-script-metrics.spec.ts`; guarded by `INVOKED_AS_SCRIPT` so importing doesn't spawn a run.
- `vitest.config.ts` (unit, no Mongo) + `vitest-e2e.config.ts` (mongod + globalSetup) + `vitest.include-globs.ts` (shared include globs, single source of truth). Routing enforced by `tests/unit/test-file-routing.spec.ts` (every `*.spec.ts`/`*.test.ts` claimed by exactly one runner). Coverage split: `./coverage/unit` vs `./coverage/e2e` (separate processes).
- `package.json` `pnpm.overrides` + parallel `pnpm.//overrides` doc-comment map — security-driven transitive pins. Project rule: override **targets must be fixed versions** (`.claude/rules/package-management.md`), and each override should be documented in the `//overrides` map.
- `bin/migrate.js` — migration CLI shim, must resolve across 3 layouts (npm / vendored repo / vendored prod image).

**CI reality:** `.github/workflows/{build,publish}.yml` both just run `pnpm run prepublishOnly` (= `lint && test:ci`) + `pnpm run build`. **No coverage upload, no codecov, no separate lint/test/deploy stages, no `lt server permissions` gate.** So coverage-dir changes never affect CI, and `test:ci` is the real gate (blocks publish via `prepublishOnly`).

See [[feedback-review-uncommitted-worktree]] for how these reviews are requested.
