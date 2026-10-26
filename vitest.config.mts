import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

import { UNIT_TEST_INCLUDE } from './vitest.include-globs.mjs';

export default defineConfig({
  // Vite 8 switched the default TS/JS transformer from esbuild to Oxc. unplugin-swc
  // disables esbuild internally — without `oxc: false`, Oxc would still run in parallel.
  oxc: false,
  // Probe extensionless files in NODE's order: `.js` before `.mjs`. Vite's default tries `.mjs` first, so a package
  // whose `main` has no extension — graphql: `"main": "index"` next to `index.mjs`, no `exports` — loads its ESM build
  // for an `import` while Node (and every `require`) loads `index.js`. Two graphql instances in one test process, and
  // a schema built by @nestjs/graphql is refused by our `execute()`: "Cannot use GraphQLSchema from another module or
  // realm". The source imports graphql with `import` since 12.0.0 (valid as CommonJS and ESM), which is what exposed
  // it. Pinned by tests/unit/vitest-node-resolution.spec.ts.
  resolve: { extensions: ['.js', '.mjs', '.mts', '.ts', '.jsx', '.tsx', '.json'] },
  plugins: [swc.vite()],
  test: {
    // Deliberate, and stated so vitest 5 stops suggesting `isolate: false`: the suites rely on fresh module state
    // per file — static registries (RolesGuardRegistry, the tenant-guard and cron registries), CoreBetterAuthModule's
    // static instance, ConfigService's singleton. Sharing them across files would make results order-dependent.
    isolate: true,
    // Separate directory from the e2e runner's report — the two suites run as separate vitest
    // processes and would otherwise overwrite each other's coverage. `pnpm run test:cov` runs both.
    coverage: { reportsDirectory: './coverage/unit' },
    // Write console output straight to the process streams instead of routing it through
    // vitest's worker→main RPC. This is the fix for an `EnvironmentTeardownError` that failed
    // roughly 1 run in 10 with EVERY test green.
    //
    // The mechanism: vitest normally replaces `globalThis.console` in each worker and forwards
    // every write as an `onUserConsoleLog` RPC. At worker teardown it does not await those calls
    // — it REJECTS whatever is still in flight:
    //
    //   rpc.$rejectPendingCalls(({ method, reject }) =>
    //     reject(new EnvironmentTeardownError(`Closing rpc while "${method}" was pending`)))
    //
    // So a log written by the last test of a file can still be travelling when cleanup runs, and
    // the rejection surfaces as an unhandled error that fails the whole run. It is a RACE, not a
    // late log: the specs involved all await correctly. No vitest 4.x release changes this
    // teardown path, and 5.0 keeps it too (`$rejectPendingCalls` in the worker init, verified on
    // 5.0.5), so there is no patch to take.
    //
    // With this flag `setupConsoleLogSpy()` is skipped entirely (vitest/dist/chunks/base.*.js),
    // so the RPC that raced does not exist. Chosen over silencing the output because the output
    // is not the problem — the transport is.
    //
    // The cost, stated honestly: console lines lose their `stdout | <file>` prefix and interleave
    // in a parallel run. A green unit run currently prints about nine informational lines from
    // framework `console.*` calls (config loader, hub buffer, rate-limit capacity, dev auth URLs),
    // so this is a real if small readability loss — not the "it is silent anyway" it might look
    // like. Accepted because the lines still appear in full, vitest still names the failing test,
    // and the alternative is a check that fails roughly 1 run in 10 for no reason anyone can act on.
    disableConsoleIntercept: true,
    environment: 'node',
    globals: true,
    // Shared with test-file-routing.spec.ts — see vitest.include-globs.mts.
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
    // The signal guard: a unit test may only signal processes it spawned (see its header).
    setupFiles: ['tests/setup.ts', 'tests/unit/support/signal-guard.setup.ts'],
  },
});
