import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

import { UNIT_TEST_INCLUDE } from './vitest.include-globs';

export default defineConfig({
  // Vite 8 switched the default TS/JS transformer from esbuild to Oxc. unplugin-swc
  // disables esbuild internally — without `oxc: false`, Oxc would still run in parallel.
  oxc: false,
  plugins: [swc.vite()],
  test: {
    // Separate directory from the e2e runner's report — the two suites run as separate vitest
    // processes and would otherwise overwrite each other's coverage. `pnpm run test:cov` runs both.
    coverage: { reportsDirectory: './coverage/unit' },
    environment: 'node',
    globals: true,
    // Shared with test-file-routing.spec.ts — see vitest.include-globs.ts.
    include: UNIT_TEST_INCLUDE,
    root: './',
    // Same setup as the e2e runner: restricts the Nest Logger to error/fatal and filters the
    // intentional @UnifiedField deprecation warnings. Without it the unit run drowns in expected
    // DEBUG/WARN output that the e2e run suppresses.
    setupFiles: ['tests/setup.ts'],
  },
});
