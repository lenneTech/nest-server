import os from 'node:os';

import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Opt-in low-resource mode — for running MANY e2e suites at once on one machine
// (e.g. several parallel `lt dev` / `lt ticket` environments). Set
// CHECK_LOW_RESOURCE=1 to cap parallel forks and raise timeouts so the suites
// share CPU/mongod without starving each other into request timeouts (the
// failure mode observed when 2+ full e2e runs overlap — tests hang past the
// 30s testTimeout and auth queries fail as 401s). Unset (default) = full speed,
// no cap. Optionally pin the fork cap with CHECK_LOW_RESOURCE_FORKS=<n>.
const LOW_RESOURCE_RAW = process.env.CHECK_LOW_RESOURCE;
const LOW_RESOURCE = !!LOW_RESOURCE_RAW && LOW_RESOURCE_RAW !== '0' && LOW_RESOURCE_RAW !== 'false';
const LOW_RESOURCE_FORKS = (() => {
  if (!LOW_RESOURCE) return undefined;
  const explicit = Number(process.env.CHECK_LOW_RESOURCE_FORKS);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  return Math.max(2, Math.floor((os.cpus()?.length || 4) / 3));
})();
if (LOW_RESOURCE) {
  process.stderr.write(`[e2e] low-resource mode active: maxForks=${LOW_RESOURCE_FORKS}, timeouts raised\n`);
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
    environment: 'node',
    // Exclude type-only test files (run these with `npx tsc --noEmit` instead)
    // and test-infrastructure modules (global setup, worker setup, DB reporter)
    exclude: ['tests/types/**/*.ts', 'tests/global-setup.ts', 'tests/setup.ts', 'tests/db-lifecycle.reporter.ts'],
    // Enable parallel file execution for speed
    fileParallelism: true,
    globalSetup: ['tests/global-setup.ts'],
    globals: true,
    // Hooks are NOT covered by `retry` (tests only) — a beforeAll that boots a
    // full Nest app can exceed 60s under load (parallel transform/import),
    // which failed whole files without any retry. Be generous here.
    hookTimeout: LOW_RESOURCE ? 240000 : 120000,
    include: ['tests/**/*.ts'],
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
    // Retry flaky tests up to 3 times before failing
    // This handles intermittent MongoDB race conditions
    retry: 5,
    root: './',
    teardownTimeout: 30000,
    testTimeout: LOW_RESOURCE ? 60000 : 30000,
    // Optimize file watching (not needed in CI)
    watch: false,
  },
});
