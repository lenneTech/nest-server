import os from 'node:os';

import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

import { countOtherActiveRuns } from './tests/e2e-run-slots';
import { E2E_TEST_INCLUDE } from './vitest.include-globs';

// Low-resource mode — caps parallel forks and raises timeouts so many e2e suites can share one
// machine's CPU and mongod without starving each other. The failure mode it prevents is real and
// nasty: when two full e2e runs overlap (several `lt dev` / `lt ticket` environments, or simply a
// forgotten background run), requests queue past the 30s testTimeout, auth queries come back as
// 401s, and supertest connections die with `socket hang up` — all of which read like genuine
// product bugs while being pure resource starvation.
//
// It used to be OPT-IN via CHECK_LOW_RESOURCE=1, and that is the wrong default: the mode only helps
// the developer who already knows the env var exists, which is exactly the developer who does not
// need it. Whoever gets bitten is the one who has never heard of it, staring at a "flaky" auth test.
//
// So it AUTO-ENABLES on either of two signals. Explicit settings still win, in both directions:
//
//   CHECK_LOW_RESOURCE=1 / true  -> force on   (CI, or a machine you know is busy)
//   CHECK_LOW_RESOURCE=0 / false -> force off  (benchmarking; never auto-throttle)
//   unset                        -> auto       (on iff another e2e run is active OR load is high)
//
// Signal 1 — another e2e run is ACTIVE right now (slot files of tests/e2e-run-slots.ts, checked
// by PID-liveness). This is the deterministic signal: measured on 12 cores, a single full-speed
// run only drives the 1-minute load average up near its END (~2.5 -> 9 over 34s), so a second
// run starting 15s in still sees a "calm" machine — the load heuristic alone structurally cannot
// catch overlapping starts. The slot count can.
//
// Signal 2 — the 1-minute load average normalised per core is already high (>= LOAD_THRESHOLD).
// This catches machine pressure from anything that is NOT an e2e run (builds, dev servers, other
// tools). Load average is unavailable on Windows (os.loadavg() returns zeros), where this signal
// simply stays off — the slot signal and the explicit flag remain available.
const LOAD_THRESHOLD = 0.7;

const CORES = os.availableParallelism?.() ?? os.cpus()?.length ?? 4;
const NORMALISED_LOAD = (os.loadavg()?.[0] ?? 0) / CORES;
const ACTIVE_E2E_RUNS = countOtherActiveRuns();

const LOW_RESOURCE_RAW = process.env.CHECK_LOW_RESOURCE;
const LOW_RESOURCE_FORCED_OFF = LOW_RESOURCE_RAW === '0' || LOW_RESOURCE_RAW === 'false';
const LOW_RESOURCE_FORCED_ON = !!LOW_RESOURCE_RAW && !LOW_RESOURCE_FORCED_OFF;
const LOW_RESOURCE_AUTO =
  LOW_RESOURCE_RAW === undefined && (ACTIVE_E2E_RUNS > 0 || NORMALISED_LOAD >= LOAD_THRESHOLD);
const LOW_RESOURCE = LOW_RESOURCE_FORCED_ON || LOW_RESOURCE_AUTO;

// On a GitHub-hosted runner, Signal 2 measures this job, not the machine. Such a runner runs ONE
// job per VM, and the e2e config is loaded about a second after the job's own `vitest:unit`
// finished — whose load is still in the 1-minute average (0.84–0.92/core on the runner builds of
// 11.42.8–11.42.10, with nothing else running). Capping on that load throttles every build and
// release against a contention that does not exist: measured on hosted 4-vCPU runners, the forced
// cap (2 workers) took the e2e step from 133 s to 198 s mean wall time, +25 % after normalising
// for runner speed, and every capped run was slower than every uncapped one. So there a load-only
// trigger keeps the raised timeouts — what CI has run with since Vitest 4 discarded the old cap —
// and leaves the worker count alone. The deterministic triggers still cap: the explicit flag
// (check:mutations forces it per lane to divide the machine) and an active slot.
//
// Keyed on `RUNNER_ENVIRONMENT === 'github-hosted'` (set by GitHub Actions on its own runners
// only; a self-hosted one reports `self-hosted`), NOT on `CI`. The one-job-per-VM premise is what
// makes the exception correct, and a shared runner breaks it: a GitLab runner that starts several
// test jobs at once carries real contention (measured 2.6–5.0/core in a consuming project), sets
// `CI` but never `RUNNER_ENVIRONMENT`, and keeps the cap.
const ON_GITHUB_HOSTED_RUNNER = process.env.RUNNER_ENVIRONMENT === 'github-hosted';
const LOAD_ONLY_TRIGGER = LOW_RESOURCE_AUTO && ACTIVE_E2E_RUNS === 0;
const CAP_WORKERS = LOW_RESOURCE && !(ON_GITHUB_HOSTED_RUNNER && LOAD_ONLY_TRIGGER);

const LOW_RESOURCE_FORKS = (() => {
  if (!LOW_RESOURCE) return undefined;
  const explicit = Number(process.env.CHECK_LOW_RESOURCE_FORKS);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  return Math.max(2, Math.floor(CORES / 3));
})();

if (LOW_RESOURCE) {
  const why = LOW_RESOURCE_FORCED_ON
    ? 'CHECK_LOW_RESOURCE set'
    : ACTIVE_E2E_RUNS > 0
      ? `${ACTIVE_E2E_RUNS} other e2e run(s) active on this machine`
      : `machine is busy (load ${NORMALISED_LOAD.toFixed(2)}/core >= ${LOAD_THRESHOLD})`;
  // Names the option actually set below. It said `maxForks` while the option it named had been
  // removed from vitest — so the one line that could have revealed the dead setting instead
  // asserted it was working. A log line that names its own option keeps that honest, including
  // when no cap is set at all.
  const effect = CAP_WORKERS
    ? `maxWorkers=${LOW_RESOURCE_FORKS}, timeouts raised`
    : 'timeouts raised, workers not capped (on a GitHub-hosted runner the load is this job\'s own previous step)';
  process.stderr.write(`[e2e] low-resource mode: ${why} -> ${effect}\n`);
}

export default defineConfig({
  // Vite 8 switched the default TS/JS transformer from esbuild to Oxc. unplugin-swc
  // disables esbuild internally — without `oxc: false`, Oxc would still run in parallel.
  oxc: false,
  plugins: [
    swc.vite({
      jsc: {
        transform: {
          useDefineForClassFields: false,
        },
      },
    }),
  ],
  test: {
    // Separate directory from the unit runner's report — see vitest.config.ts.
    coverage: { reportsDirectory: './coverage/e2e' },
    environment: 'node',
    // No `exclude` needed: the `include` patterns below match neither the type-only tests
    // (`tests/types/**/*.type-test.ts`, run via `pnpm run test:types`) nor the test-infrastructure
    // modules (global setup, worker setup, DB reporter). Leaving `exclude` unset keeps vitest's
    // own defaults (node_modules, dist, …) in place instead of replacing them.
    // Enable parallel file execution for speed
    // Same reasoning as vitest.config.ts — see the long comment there. Applied here too, and if
    // anything the exposure is larger: the e2e suite boots real apps and logs far more, so more
    // console writes are in flight at any worker teardown. `pnpm run check` runs BOTH suites
    // (`test` = `vitest:unit && vitest`), so leaving one half on the RPC path would keep the
    // check flaky for the same reason.
    disableConsoleIntercept: true,
    fileParallelism: true,
    globalSetup: ['tests/global-setup.ts'],
    globals: true,
    // Hooks are NOT covered by `retry` (tests only) — a beforeAll that boots a
    // full Nest app can exceed 60s under load (parallel transform/import),
    // which failed whole files without any retry. Be generous here.
    hookTimeout: LOW_RESOURCE ? 240000 : 120000,
    // Matches the unit runner — see vitest.config.ts for the timing (restore happens
    // BEFORE each attempt, so a `beforeAll`-installed spy does not survive) and for
    // why a leaked spy is worse than it looks.
    restoreMocks: true,
    // Suites that need the mongod + globalSetup this config provides: e2e specs and story
    // tests. Naming the patterns explicitly (instead of `tests/**/*.ts`) keeps helpers,
    // setup and reporters out — and, crucially, keeps `tests/unit/**` out: those are plain
    // unit tests, run by vitest.config.ts, against a database they neither need nor use.
    // The patterns live in vitest.include-globs.ts, shared with
    // `tests/unit/test-file-routing.spec.ts`, which asserts that every *.spec.ts / *.test.ts file
    // in the repo is claimed by exactly one of the two runners — so narrowing them can never
    // silently drop a suite.
    include: E2E_TEST_INCLUDE,
    // Runs in every test worker before test files are imported (filters expected log/warn noise)
    setupFiles: ['tests/setup.ts'],
    // PARALLEL CONFIGURATION: Fast execution with retry mechanism
    // Files run in parallel for maximum speed
    // Flaky tests are automatically retried up to 3 times
    // Isolate each test file in its own process for stability
    isolate: true,
    // Allow multiple files to run concurrently
    maxConcurrency: 3,
    // Use forks instead of threads for better NestJS performance
    pool: 'forks',
    // Cap parallel workers ONLY in low-resource mode (see CHECK_LOW_RESOURCE above); default =
    // vitest's own (~CPU count) for full-speed solo runs.
    //
    // `maxWorkers`, NOT `poolOptions.forks.maxForks`. Vitest 4 removed `poolOptions`: in 4.1.11
    // the key occurs exactly once in `vitest/dist`, inside `logger.deprecate(...)`, and
    // `maxForks` / `minForks` do not occur at all. So the cap was logged and discarded — measured
    // here and in a consuming project (8 e2e files, 12 cores), a run announcing "maxForks=2" used
    // 8 forks, while the same run with `maxWorkers` used 2. Low-resource mode was therefore a pure timeout
    // extension: it waited twice as long before calling a timeout instead of removing the
    // contention that caused it, which is the opposite of what the block above promises.
    //
    // Worth knowing WHY nothing caught it, because the next removed option will hit the same gap:
    // this repo's `module: commonjs` cannot resolve vitest's ESM-only type imports (`vite`,
    // `@vitest/utils/display`); `skipLibCheck` hides that, the config type collapses to `any`, and
    // an unknown or removed option passes. The guard is tests/unit/vitest-e2e-config.spec.ts. It
    // asserts the value this config resolves from the environment, so the `poolOptions` regression
    // fails there (registered mutation `e2e-low-resource-cap-pooloptions`). It cannot catch Vitest
    // dropping `maxWorkers` itself: vitest's own resolved config is `{...configDefaults, ...options}`
    // and carries a removed option through unchanged — that is how `poolOptions` slipped by. Only
    // counting the forks of a real run proves that vitest honours the key.
    // `maxWorkers?: number | string`, so `undefined` is the correct "leave at the default".
    //
    // `minWorkers` is deliberately absent: it does not exist in 4.1.11 either.
    //
    // `CAP_WORKERS` rather than `LOW_RESOURCE`: see the runner note at its definition.
    maxWorkers: CAP_WORKERS ? LOW_RESOURCE_FORKS : undefined,
    // db-lifecycle: drops this run's unique DB on success (+ collects stale
    // run DBs), keeps it for debugging on failure — see tests/db-lifecycle.reporter.ts
    reporters: ['default', './tests/db-lifecycle.reporter.ts'],
    // Retry flaky tests before failing (intermittent MongoDB race conditions).
    // Deliberately LOW: retry multiplies worst-case runtime per test. Observed
    // failure mode with retry: 5 — one spec file whose app/socket state broke
    // under resource pressure ground through (1+5) attempts × 30s testTimeout ×
    // 22 tests ≈ an hour at 0% CPU, indistinguishable from a deadlock (this is
    // what the check.mjs watchdog used to kill). The e2e-run governor removes
    // the pressure trigger; retry: 2 caps the multiplier at 3× as backstop.
    retry: 2,
    root: './',
    teardownTimeout: 30000,
    testTimeout: LOW_RESOURCE ? 60000 : 30000,
    // Optimize file watching (not needed in CI)
    watch: false,
  },
});
