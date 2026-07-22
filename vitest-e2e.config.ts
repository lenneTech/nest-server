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
  process.stderr.write(`[e2e] low-resource mode: ${why} -> maxForks=${LOW_RESOURCE_FORKS}, timeouts raised\n`);
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
    // Cap parallel fork workers ONLY in low-resource mode (see CHECK_LOW_RESOURCE
    // above); default = vitest's own (~CPU count) for full-speed solo runs.
    ...(LOW_RESOURCE ? { poolOptions: { forks: { maxForks: LOW_RESOURCE_FORKS, minForks: 1 } } } : {}),
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
