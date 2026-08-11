# Testing Configuration

## Test Framework

**Vitest**, split across two runners. Which one claims a file is decided purely by its filename:

| Runner | Config | Test files | Needs MongoDB |
|--------|--------|-----------|:-------------:|
| Unit | `vitest.config.ts` | `tests/unit/**/*.spec.ts` | No |
| E2E | `vitest-e2e.config.ts` | `tests/**/*.e2e-spec.ts`, `tests/stories/**/*.story.test.ts` | Yes |

**Test files NEVER live in `src/`.** Not a style preference — `src/` is this framework's shipping
artifact: `package.json` → `files` ships all of `src` recursively into the npm tarball, and
vendor-mode consumers copy `src/core/` into their own tree as first-class project code (the CLI's
`convertCloneToVendored` applies no spec filter). A co-located spec therefore reaches every consumer
as a test file they neither run nor maintain, re-delivered on every core update. Co-location is a
fine default for an application; for a library whose `src/` IS the delivery, separation wins.

Enforced twice: the unit runner's glob no longer looks at `src/` at all, and
`tests/unit/test-file-placement.spec.ts` fails on any `.spec.ts`/`.test.ts` found there — so a
misplaced test surfaces as a failure rather than as silently skipped coverage.

| Kind | Where | Suffix |
|------|-------|--------|
| Unit | `tests/unit/` | `*.spec.ts` |
| E2E / integration | `tests/` | `*.e2e-spec.ts` |
| Story (e2e-grade) | `tests/stories/` | `*.story.test.ts` |
| Type-only (compiled, never run) | `tests/types/` | `*.type-test.ts` |

A file matching neither pattern would run nowhere. `tests/unit/test-file-routing.spec.ts` asserts
that every `*.spec.ts` / `*.test.ts` in the repo is claimed by **exactly one** runner, so a
mis-named suite fails the build instead of silently passing. Type-only tests
(`tests/types/*.type-test.ts`) are compiled by `pnpm run test:types`, never executed.

## Infrastructure containers (Redis + S3)

**Seven** e2e suites talk to a **real** Redis and/or a **real** S3-compatible store rather than a
mock, and they **fail loudly** when it is missing — a silently skipped infrastructure test is how an
untested driver ships:

| Suite | Needs |
|-------|-------|
| `tests/redis-infra.e2e-spec.ts` | Redis |
| `tests/redis-consumers.e2e-spec.ts` | Redis |
| `tests/multi-replica.e2e-spec.ts` | Redis |
| `tests/s3-infra.e2e-spec.ts` | S3 |
| `tests/file-storage-s3.e2e-spec.ts` | S3 |
| `tests/redis-s3-bootstrap.e2e-spec.ts` | Redis + S3 |
| `tests/graceful-shutdown.e2e-spec.ts` | Redis + S3 |

`tests/global-setup.ts` starts both containers automatically, so `pnpm test` works from a clean
machine with no manual docker command. It is idempotent (a running container is reused) and never
fatal: without Docker every other suite still runs, and the seven above report their own actionable
error.

```bash
pnpm run test:infra          # start + wait for readiness (also runs automatically)
pnpm run test:infra:status   # what is running
pnpm run test:infra:down     # stop and remove
```

| | Redis | S3 (RustFS) |
|---|---|---|
| Port | 6380 (6379 is an auth-protected TurboOps Redis on lt dev machines) | 9102 |
| Container | `nest-server-2985-redis` | `nest-server-2985-rustfs` |

**CI provisions its own** containers in `.github/workflows/*.yml` and sets `LT_TEST_INFRA=0` so the
automatic start stays out of the way. Same images, same ports — only who starts them differs. Set
`LT_TEST_INFRA=0` locally too if you want to manage them yourself.

**Bucket cleanup:** every suite that creates a bucket names it per run and removes it in `afterAll`
via `tests/helpers/s3-test-cleanup.ts`. Emptying and deleting belong together — a bucket cannot be
deleted while it holds objects — which is why that lives in one helper rather than per suite. Before
it existed, two empty buckets leaked into the store per run.

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
- Infrastructure containers (E2E only, the **seven** specs listed under "Infrastructure containers"
  above) round-trip against a REAL Redis and/or a REAL S3-compatible store.
  `redis-s3-bootstrap` boots the assembled `CoreModule` with both
  configured — the only test that covers the WIRING, which fakes and directly-constructed
  services cannot: an unresolvable provider or a lifecycle hook that throws on a real
  connection would pass every other spec and fail on a consumer's first `nest start`. `multi-replica` is the acceptance test for the
  distributed features: it builds TWO independent service instances sharing one Redis and
  asserts the properties a second replica must preserve — a scheduled tick and a startup tick
  each run exactly once, one rate limit is enforced instead of one per replica, and a severed
  Redis still yields a decision instead of an error. Single-instance specs against fakes cannot
  show any of that: a limiter counting per process, or a lease key differing per instance,
  passes them and fails here. `redis-consumers` covers the framework's own Redis consumers seen
  from two replicas, `file-storage-s3` runs `CoreFileService` against a real bucket, and
  `graceful-shutdown` needs real connections for `installGracefulShutdown()` to close.
  Five of the seven preflight the connection in `beforeAll` and throw a written diagnosis —
  `redis-infra`, `s3-infra` and `multi-replica` quote the full `docker run` line, `redis-consumers`
  and `file-storage-s3` name the port and how to start it. So a forgotten container is a ~2s clear
  error instead of a 43s opaque `MaxRetriesPerRequestError`. The other two fail fast without a
  custom message: `graceful-shutdown` probes with `connectTimeout: 2000` /
  `maxRetriesPerRequest: 1` and lets the raw connect error surface, and `redis-s3-bootstrap` has no
  separate probe at all — its `beforeAll` IS the boot.

  ```bash
  docker run -d --name nest-server-2985-redis -p 6380:6379 redis:7.4-alpine
  docker run -d --name nest-server-2985-rustfs -p 9102:9000 -e RUSTFS_ROOT_USER=rustfs -e RUSTFS_ROOT_PASSWORD=rustfs-secret -e RUSTFS_VOLUMES=/data rustfs/rustfs:1.0.0-rc.1 server /data
  ```

  Both tags are pinned, and these hints must stay identical to the tags in
  `scripts/test-infra.mjs` / `.github/actions/test-infra/action.yml`. `containerMatches()` compares
  the running container's image against the pinned one, so a hint that says `:latest` starts a
  container the next `pnpm test` tears down and recreates.

  | Service | Port | Overridable via |
  |---------|------|-----------------|
  | Redis | 6380 | `REDIS_HOST`, `REDIS_PORT` |
  | RustFS (S3) | 9102 | `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` |

  **Why 6380 and not 6379:** on lt dev machines 6379 is occupied by an auth-protected TurboOps
  Redis. Binding the test container to 6380 keeps the two apart — no auth setup, no cross-wiring.
  CI (`.github/workflows/build.yml` / `publish.yml`) maps the same ports and waits for readiness
  before installing dependencies.
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
