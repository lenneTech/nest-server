import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

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
    exclude: ['tests/types/**/*.ts', 'tests/global-setup.ts', 'tests/setup.ts'],
    // Enable parallel file execution for speed
    fileParallelism: true,
    globalSetup: ['tests/global-setup.ts'],
    globals: true,
    hookTimeout: 60000,
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
    reporters: ['default'],
    // Retry flaky tests up to 3 times before failing
    // This handles intermittent MongoDB race conditions
    retry: 5,
    root: './',
    teardownTimeout: 30000,
    testTimeout: 30000,
    // Optimize file watching (not needed in CI)
    watch: false,
  },
});
