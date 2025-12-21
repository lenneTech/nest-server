/**
 * Story: User Enumeration Prevention - Default Behavior
 *
 * This test verifies the default behavior (backward compatible):
 * - "Unknown email" - when email doesn't exist
 * - "Wrong password" - when password is incorrect
 * - "No password set for this account" - for social login only users
 *
 * This is the default when preventUserEnumeration is false or not set.
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
  const email = `user-enum-default-${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
  testEmails.push(email);
  return email;
};

// Config: Default behavior (preventUserEnumeration: false)
const testConfig = {
  ...envConfig,
  auth: {
    ...envConfig.auth,
    preventUserEnumeration: false, // Default: specific error messages
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

describe('Story: User Enumeration - Default Behavior (specific error messages)', () => {
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

  it('should return "Unknown email" when email does not exist', async () => {
    const nonExistentEmail = generateTestEmail('nonexistent');
    const password = 'SomePassword123!';

    const result = await testHelper.graphQl({
      arguments: { input: { email: nonExistentEmail, password } },
      fields: ['token'],
      name: 'signIn',
      type: TestGraphQLType.MUTATION,
    });

    expect(result.errors).toBeDefined();
    expect(result.errors[0].message).toContain('Unknown email');
  });

  it('should return "Wrong password" when password is incorrect', async () => {
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
    expect(result.errors[0].message).toContain('Wrong password');
  });

  it('should return "No password set for this account" for social login only users', async () => {
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
    expect(result.errors[0].message).toContain('No password set for this account');
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
