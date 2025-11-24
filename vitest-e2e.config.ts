import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
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
    // Inline dependencies to prevent dual CJS/ESM loading of graphql
    deps: {
      inline: true,
    },
    environment: 'node',
    exclude: [],
    // Enable parallel file execution for speed
    fileParallelism: true,
    globals: true,
    hookTimeout: 60000,
    include: ['tests/**/*.ts'],
    // PARALLEL CONFIGURATION: Fast execution with retry mechanism
    // Files run in parallel for maximum speed
    // Flaky tests are automatically retried up to 3 times
    // Isolate each test file in its own process for stability
    isolate: true,
    // Allow multiple files to run concurrently
    maxConcurrency: 4,
    // Use forks instead of threads for better NestJS performance
    pool: 'forks',
    reporters: ['default'],
    // Retry flaky tests up to 3 times before failing
    // This handles intermittent MongoDB race conditions
    retry: 3,
    root: './',
    teardownTimeout: 30000,
    testTimeout: 30000,
    // Optimize file watching (not needed in CI)
    watch: false,
  },
});
