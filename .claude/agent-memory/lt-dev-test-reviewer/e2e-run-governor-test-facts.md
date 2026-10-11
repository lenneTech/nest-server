---
name: e2e-run-governor-test-facts
description: Facts for reviewing tests of tests/e2e-run-slots.ts and the vitest-e2e.config low-resource cap (vitest 4.1.11) — what is machine-dependent and what is not
metadata:
  type: project
---

Reviewed 2026-10-11 (slot hardening + `maxWorkers` fix, uncommitted on develop at the time).

- **vitest 4 `maxWorkers: undefined` is safe**: `resolveMaxWorkers()` (cli-api chunk) falls back to
  `numCpus - 1` on a falsy value, so the ternary `CAP_WORKERS ? N : undefined` does not throttle a solo run.
  `CAP_WORKERS` is `LOW_RESOURCE` minus one case: a load-only trigger on `RUNNER_ENVIRONMENT=github-hosted`
  (measured +25 % e2e time there for the cap). A spec of the config must therefore also pin
  `RUNNER_ENVIRONMENT` — the existing spec does, plus a refusal case for `self-hosted` / no runner env.
  `poolOptions` only triggers a `logger.deprecate` line, nothing else reads it.
- **Unit-importing `vitest-e2e.config.ts` has one side effect**: `countOtherActiveRuns()` runs at load and
  UNLINKS dead/stale slot files in `slotDir()`. A spec importing the config must point `LT_E2E_SLOT_DIR` at a
  temp dir (the existing spec does) and pin `CHECK_LOW_RESOURCE` (or mock `os.loadavg`) so machine load/real runs cannot flip auto mode.
- **`restoreMocks: true` runs before `beforeEach`** (runner `onBeforeTryTask`), so a spy installed in
  `beforeEach` survives into the test; one installed in `beforeAll` does not.
- **Machine dependence, verified green under `umask 077` + `CI=true` + hostile pre-set env**. The only
  sensitivity: under umask 077 the 0700-directory test stays green WITH the `e2e-slot-claim-follows-symlink`
  mutation applied (the symlink test still goes red, so the mutation stays confirmed). Root does not change it.
- **`isPidAlive()` treats EPERM as dead**: another user's slot is never counted and cannot be unlinked in a
  0755 dir. That is why the second (timeout-path) claim catch is practically unreachable — not worth a test.
- `process.ppid` as "a live foreign PID" is the established pattern in `tests/unit/e2e-run-slots.spec.ts`;
  it works on Windows too (`process.kill(pid, 0)` existence check).

Related: [[e2e-isolation-model]], [[scratch-copy-mutation-check]].
