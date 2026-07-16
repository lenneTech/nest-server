# Testing Configuration

## Test Framework

**Vitest**, split across two runners. Which one claims a file is decided purely by its filename:

| Runner | Config | Test files | Needs MongoDB |
|--------|--------|-----------|:-------------:|
| Unit | `vitest.config.ts` | `src/**/*.spec.ts`, `tests/unit/**/*.spec.ts` | No |
| E2E | `vitest-e2e.config.ts` | `tests/**/*.e2e-spec.ts`, `tests/stories/**/*.story.test.ts` | Yes |

A file matching neither pattern would run nowhere. `tests/unit/test-file-routing.spec.ts` asserts
that every `*.spec.ts` / `*.test.ts` in the repo is claimed by **exactly one** runner, so a
mis-named suite fails the build instead of silently passing. Type-only tests
(`tests/types/*.type-test.ts`) are compiled by `pnpm run test:types`, never executed.

## Running Tests

```bash
# Unit + E2E (default) — the E2E half needs MongoDB
pnpm test

# Unit tests only (fast, no MongoDB)
pnpm run vitest:unit

# E2E tests only
pnpm run test:e2e

# Both suites with coverage → coverage/unit + coverage/e2e
pnpm run test:cov

# Run in CI mode (unit + E2E with NODE_ENV=ci)
pnpm run test:ci

# Debug open handles
npx vitest run --config vitest-e2e.config.ts --reporter=hanging-process

# Clean up leftover test artifacts (.txt, .bin files from failed file upload tests)
pnpm run test:cleanup
```

## Test Environment

- Environment: `NODE_ENV=e2e` for the E2E runner (`pnpm run vitest`). The unit runner sets no
  `NODE_ENV`; vitest defaults it to `test`, and `getEnvironmentConfig()` falls back to `config.local`.
- Both runners load `tests/setup.ts` via `setupFiles` (Nest Logger restricted to `error`/`fatal`,
  `@UnifiedField` deprecation warnings filtered).
- Database (E2E only): **one unique database per run** (`nest-server-e2e-run-<ts>-p<pid>`), created by `tests/global-setup.ts` so concurrent runs cannot interfere with each other. Specs needing an extra DB derive it via `deriveTestDbUri('<suffix>')` — never a hardcoded/`Date.now()` name (escapes the cleanup scheme).
- DB lifecycle (`tests/db-lifecycle.reporter.ts`): run passes → DB dropped immediately + stale run DBs from crashed/failed runs collected; run fails → DB kept for debugging. Additionally `tests/global-setup.ts` runs a **startup sweep** (shared `isStaleTestDb()` predicate, dead-PID/age guarded) — leftovers are removed when the NEXT run starts, which survives SIGKILL (check watchdog) and `--reporter` CLI overrides. An externally set `MONGODB_URI` (CI) opts out of the scheme.
- Run governor (`tests/e2e-run-slots.ts`): machine-wide slot dir (`<tmpdir>/lt-e2e-run-slots`) caps concurrent e2e runs across ALL lt projects/sessions (default 2 on ≥8 cores). Further runs wait, logging `[e2e-governor] waiting…` every 15s (keeps the check watchdog fed — a queued run is NOT hung). The e2e config counts foreign slots at load time and drops to low-resource mode (reduced forks, raised timeouts) when another run is active — deterministic, unlike the lagging 1-min load average (kept as second signal). Knobs: `LT_E2E_MAX_RUNS` (0 disables), `LT_E2E_SLOT_DIR`, `LT_E2E_SLOT_TIMEOUT` (fail-open).
- `retry: 2` (e2e) is deliberate — with `retry: 5`, one spec file with broken app/socket state ground through 6 attempts × 30s timeout × 22 tests ≈ an hour at 0% CPU (looked like a deadlock; the check watchdog killed it). Never raise retry to paper over contention.
- Test helper: `src/test/test.helper.ts`
- Coverage: Collected from `src/**/*.{ts,js}`. The two runners are separate vitest processes, so
  they write separate reports (`coverage/unit`, `coverage/e2e`) rather than overwriting each other.

## Test Best Practices

1. **Always run tests before completing changes**: `pnpm test`
2. **Production-ready = all tests pass** without errors
3. **Use TestHelper** for GraphQL and REST API testing
4. **Clean up test data** in `afterAll` hooks
5. **Unique test data** - Use timestamps/random strings to avoid conflicts

## Test File Structure

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { TestHelper } from '../../src';

describe('Feature Name', () => {
  let testHelper: TestHelper;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [ServerModule],
    }).compile();

    const app = moduleFixture.createNestApplication();
    await app.init();
    testHelper = new TestHelper(app);
  });

  afterAll(async () => {
    // Cleanup test data
    await app.close();
  });

  it('should do something', async () => {
    const result = await testHelper.graphQl({
      name: 'someQuery',
      type: TestGraphQLType.QUERY,
      fields: ['id', 'name'],
    });
    expect(result.data.someQuery).toBeDefined();
  });
});
```

## WebSocket/Subscription Tests

When testing GraphQL subscriptions, use `httpServer.listen(0)` instead of `app.listen()`:

```typescript
// CORRECT: No startup log, dynamic port
await app.init();
const httpServer = app.getHttpServer();
await new Promise<void>((resolve) => {
  httpServer.listen(0, '127.0.0.1', () => resolve());
});
const port = httpServer.address().port;
testHelper = new TestHelper(app, `ws://127.0.0.1:${port}/graphql`);

// Cleanup in afterAll
if (httpServer) {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
}
await app.close();
```

```typescript
// WRONG: Produces "Nest application successfully started" log
await app.init();
await app.listen(3030);
```

**Why:**
- `app.listen()` triggers NestJS startup log -> noisy test output
- Dynamic port (`0`) avoids port conflicts between parallel tests
- Explicit `httpServer.close()` prevents open handle warnings

## TestHelper Reference

Full documentation for TestHelper (REST, GraphQL, Cookie support):
`src/test/README.md` (also available in `node_modules/@lenne.tech/nest-server/src/test/README.md`)

## Common Test Issues

- **Tests timeout**: Ensure MongoDB is running
- **Open handles**: Run vitest with `--reporter=hanging-process` to debug
- **Data conflicts**: Use unique identifiers per test
- **"NestApplication successfully started" log**: Use `httpServer.listen()` instead of `app.listen()`
