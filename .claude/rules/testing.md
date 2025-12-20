# Testing Configuration

## Test Framework

- **Vitest** - Primary test framework (migrated from Jest)
- Configuration: `vitest.config.ts`
- Test files: `tests/` directory with `.e2e-spec.ts` suffix

## Running Tests

```bash
# Run all E2E tests (default)
npm test

# Run with coverage
npm run test:cov

# Run in CI mode
npm run test:ci

# Debug open handles
npm run test:e2e-doh
```

## Test Environment

- Environment: `NODE_ENV=local`
- Database: Local MongoDB instance (`mongodb://127.0.0.1/nest-server-local`)
- Test helper: `src/test/test.helper.ts`
- Coverage: Collected from `src/**/*.{ts,js}`

## Test Best Practices

1. **Always run tests before completing changes**: `npm test`
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

## Common Test Issues

- **Tests timeout**: Ensure MongoDB is running
- **Open handles**: Use `npm run test:e2e-doh` to debug
- **Data conflicts**: Use unique identifiers per test
