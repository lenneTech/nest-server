---
name: project-e2e-node-env-trap
description: Running the e2e suite without NODE_ENV=e2e fabricates 5 bogus BetterAuth "Invalid credentials" failures — a false-positive CRITICAL trap for security reviewers
metadata:
  type: project
---

Never invoke the e2e suite as bare `npx vitest run --config vitest-e2e.config.ts`. Always use `pnpm run test:e2e` (or prefix `NODE_ENV=e2e` manually) — the package script is `NODE_ENV=e2e vitest run --config vitest-e2e.config.ts`.

**Why:** without `NODE_ENV=e2e`, `getEnvironmentConfig()` falls back to `config.local`, and `tests/stories/better-auth-api.story.test.ts` then fails **5 auth tests** with `UnauthorizedException: #LTNS_0010: Invalid credentials` (sign-in, sign-out, 2FA, session-token). These look exactly like a genuine authentication regression and are extremely tempting to report as a Critical/High finding. They are pure invocation artifacts — the same suite is 39/39 green under `NODE_ENV=e2e`. The tell is the generated DB name: `nest-server-local-run-*` instead of an e2e-run DB.

**How to apply:** In any security review that runs e2e tests, use the package script. If auth tests fail, before writing the finding: (1) check the DB name in the output for `-local-run-`, (2) re-run with `NODE_ENV=e2e`, (3) only then run the base branch as a control. Diffing against the base branch alone does NOT catch this — the bogus failures reproduce identically on `develop`, which makes them look like a real "pre-existing broken auth" issue rather than an artifact.

Related: [[project-betterauth-di-failclosed-and-cycle-triage]].
