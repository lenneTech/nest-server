---
name: vitest-projects-global-setup-order
description: vitest 5.0.5 with `projects` — a project's own globalSetup runs BEFORE the root config's globalSetup, the root one runs once (not merged per project), and a throwing project setup aborts the WHOLE run before the root setup runs
metadata:
  type: reference
---

Probed 2026-10-28 with the repo's vitest 5.0.5 in a scratch dir (dummy setups writing to a log;
symlink the repo's node_modules into the scratch dir or `vitest/config` does not resolve):

- Root `test.globalSetup` + project with `extends: true` and its own `globalSetup`:
  order is `project setup` → `root setup` → tests → `root teardown` → `project teardown`.
- The root setup runs ONCE, with no project name; it is not merged into each project.
- A project setup that throws: vitest exits 1, prints the error, runs NO test file at all, and the
  root setup never runs.

Why it matters here: `tests/global-setup.ts` (root) is what starts the Redis/S3/PostgreSQL
containers (`startTestInfra()`). Any project-level setup that needs a container
(`tests/iam-sql.global-setup.ts`, DEV-3831) runs before that start — on a machine where the
container is stopped, the whole e2e run aborts and never self-heals. See [[db-agnostic-persistence-test-facts]].

How to apply: when a project-level globalSetup needs infrastructure, check that it provisions it
itself; never trust a doc line saying "the other projects are unaffected" by a project setup failure.
