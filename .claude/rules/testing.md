# Testing Configuration

## Test Framework

- **Vitest** - Primary test framework (migrated from Jest)
- Configuration: `vitest.config.ts`
- Test files: `tests/` directory with `.e2e-spec.ts` suffix

## Running Tests

```bash
# Run all E2E tests (default)
pnpm test

# Run with coverage
pnpm run test:cov

# Run in CI mode
pnpm run test:ci

# Debug open handles
pnpm run test:e2e-doh

# Clean up leftover test artifacts (.txt, .bin files from failed file upload tests)
pnpm run test:cleanup
```

## Test Environment

- Environment: `NODE_ENV=local`
- Database: Local MongoDB instance (`mongodb://127.0.0.1/nest-server-local`)
- Test helper: `src/test/test.helper.ts`
- Coverage: Collected from `src/**/*.{ts,js}`

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
- **Open handles**: Use `pnpm run test:e2e-doh` to debug
- **Data conflicts**: Use unique identifiers per test
- **"NestApplication successfully started" log**: Use `httpServer.listen()` instead of `app.listen()`
