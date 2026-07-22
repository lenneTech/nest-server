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
    // Restore every `vi.spyOn` before each test attempt (vitest does this in
    // `onBeforeTryTask`, i.e. ahead of `beforeEach` and of every retry). Without it, a
    // spy whose manual `mockRestore()` is skipped because an assertion threw stays
    // installed for the rest of the worker — and a stubbed `Logger.prototype.error`
    // silences real error output during exactly the run that is already failing.
    // Note the timing: a spy installed in `beforeAll` does NOT survive to the first
    // test. Install spies in `beforeEach` or inside the test body.
    // Only `vi.spyOn` is affected; plain `vi.fn()` and `vi.mock()` factories are not.
    restoreMocks: true,
    root: './',
    // Same setup as the e2e runner: restricts the Nest Logger to error/fatal and filters the
    // intentional @UnifiedField deprecation warnings. Without it the unit run drowns in expected
    // DEBUG/WARN output that the e2e run suppresses.
    setupFiles: ['tests/setup.ts'],
  },
});
