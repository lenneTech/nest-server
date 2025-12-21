/**
 * Story: User Enumeration Prevention - Enabled
 *
 * This test verifies behavior when preventUserEnumeration is enabled:
 * - "Invalid credentials" - returned for all auth errors
 *
 * This prevents attackers from determining whether an email address exists.
 *
 * Configuration via config.env.ts:
 * ```typescript
 * auth: {
 *   preventUserEnumeration: true
 * }
 * ```
 */

import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { Db, MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreModule, HttpExceptionLogFilter, TestGraphQLType, TestHelper } from '../../src';
import envConfig from '../../src/config.env';
import { Any } from '../../src/core/common/scalars/any.scalar';
import { DateScalar } from '../../src/core/common/scalars/date.scalar';
import { JSON as JSONScalar } from '../../src/core/common/scalars/json.scalar';
import { CoreAuthService } from '../../src/core/modules/auth/services/core-auth.service';
import { CronJobs } from '../../src/server/common/services/cron-jobs.service';
import { AuthController } from '../../src/server/modules/auth/auth.controller';
import { AuthModule } from '../../src/server/modules/auth/auth.module';
import { FileModule } from '../../src/server/modules/file/file.module';
import { ServerController } from '../../src/server/server.controller';

// Test Data
const testEmails: string[] = [];

const generateTestEmail = (prefix: string): string => {
  const email = `user-enum-prevent-${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
  testEmails.push(email);
  return email;
};

// Config: User enumeration prevention enabled
const testConfig = {
  ...envConfig,
  auth: {
    ...envConfig.auth,
    preventUserEnumeration: true, // Enable: generic "Invalid credentials" message
  },
  betterAuth: {
    ...envConfig.betterAuth,
    enabled: false, // Disable BetterAuth for simpler testing
  },
};

@Module({
  controllers: [ServerController, AuthController],
  exports: [CoreModule, AuthModule, FileModule],
  imports: [
    CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(testConfig.jwt), testConfig),
    ScheduleModule.forRoot(),
    AuthModule.forRoot(testConfig.jwt),
    FileModule,
  ],
  providers: [Any, CronJobs, DateScalar, JSONScalar],
})
class TestServerModule {}

describe('Story: User Enumeration Prevention Enabled (generic error messages)', () => {
  let app;
  let testHelper: TestHelper;
  let mongoClient: MongoClient;
  let db: Db;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [TestServerModule],
      providers: [{ provide: 'PUB_SUB', useValue: new PubSub() }],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new HttpExceptionLogFilter());
    app.setBaseViewsDir(testConfig.templates.path);
    app.setViewEngine(testConfig.templates.engine);
    await app.init();
    testHelper = new TestHelper(app);

    mongoClient = await MongoClient.connect(testConfig.mongoose.uri);
    db = mongoClient.db();
  });

  afterAll(async () => {
    if (db && testEmails.length > 0) {
      await db.collection('users').deleteMany({ email: { $in: testEmails } });
    }
    if (mongoClient) await mongoClient.close();
    if (app) await app.close();
  });

  it('should return "Invalid credentials" when email does not exist', async () => {
    const nonExistentEmail = generateTestEmail('nonexistent');
    const password = 'SomePassword123!';

    const result = await testHelper.graphQl({
      arguments: { input: { email: nonExistentEmail, password } },
      fields: ['token'],
      name: 'signIn',
      type: TestGraphQLType.MUTATION,
    });

    expect(result.errors).toBeDefined();
    expect(result.errors[0].message).toContain('Invalid credentials');
    // Should NOT contain specific error messages
    expect(result.errors[0].message).not.toContain('Unknown email');
  });

  it('should return "Invalid credentials" when password is incorrect', async () => {
    const email = generateTestEmail('wrong-pw');
    const correctPassword = 'CorrectPassword123!';
    const wrongPassword = 'WrongPassword123!';

    // Sign up first
    await testHelper.graphQl({
      arguments: { input: { email, password: correctPassword } },
      fields: [{ user: ['id'] }],
      name: 'signUp',
      type: TestGraphQLType.MUTATION,
    });

    // Attempt sign in with wrong password
    const result = await testHelper.graphQl({
      arguments: { input: { email, password: wrongPassword } },
      fields: ['token'],
      name: 'signIn',
      type: TestGraphQLType.MUTATION,
    });

    expect(result.errors).toBeDefined();
    expect(result.errors[0].message).toContain('Invalid credentials');
    // Should NOT contain specific error messages
    expect(result.errors[0].message).not.toContain('Wrong password');
  });

  it('should return "Invalid credentials" for social login only users', async () => {
    const email = generateTestEmail('social-only');

    // Create a user without password (simulating social login)
    await db.collection('users').insertOne({
      email,
      emailVerified: true,
      roles: [],
      verified: true,
      // No password field - social login only
    });

    // Attempt sign in
    const result = await testHelper.graphQl({
      arguments: { input: { email, password: 'AnyPassword123!' } },
      fields: ['token'],
      name: 'signIn',
      type: TestGraphQLType.MUTATION,
    });

    expect(result.errors).toBeDefined();
    expect(result.errors[0].message).toContain('Invalid credentials');
    // Should NOT contain specific error messages
    expect(result.errors[0].message).not.toContain('No password set');
  });

  it('should return same error message for both unknown email and wrong password', async () => {
    const existingEmail = generateTestEmail('exists');
    const nonExistentEmail = generateTestEmail('not-exists');
    const password = 'TestPassword123!';

    // Create one user
    await testHelper.graphQl({
      arguments: { input: { email: existingEmail, password } },
      fields: [{ user: ['id'] }],
      name: 'signUp',
      type: TestGraphQLType.MUTATION,
    });

    // Attempt with non-existent email
    const result1 = await testHelper.graphQl({
      arguments: { input: { email: nonExistentEmail, password } },
      fields: ['token'],
      name: 'signIn',
      type: TestGraphQLType.MUTATION,
    });

    // Attempt with existing email but wrong password
    const result2 = await testHelper.graphQl({
      arguments: { input: { email: existingEmail, password: 'WrongPassword123!' } },
      fields: ['token'],
      name: 'signIn',
      type: TestGraphQLType.MUTATION,
    });

    // Both should return the same generic error message
    expect(result1.errors[0].message).toBe(result2.errors[0].message);
    expect(result1.errors[0].message).toContain('Invalid credentials');
  });

  it('should allow successful sign in with correct credentials', async () => {
    const email = generateTestEmail('success');
    const password = 'CorrectPassword123!';

    // Sign up
    await testHelper.graphQl({
      arguments: { input: { email, password } },
      fields: [{ user: ['id'] }],
      name: 'signUp',
      type: TestGraphQLType.MUTATION,
    });

    // Sign in
    const result = await testHelper.graphQl({
      arguments: { input: { email, password } },
      fields: ['token', { user: ['email'] }],
      name: 'signIn',
      type: TestGraphQLType.MUTATION,
    });

    expect(result.token).toBeDefined();
    expect(result.user.email).toBe(email);
  });
});
