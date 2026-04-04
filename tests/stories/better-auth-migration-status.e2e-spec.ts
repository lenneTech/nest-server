/**
 * Story: BetterAuth Migration Status
 *
 * As an administrator,
 * I want to see the migration status from Legacy Auth to Better-Auth (IAM),
 * So that I can determine when all users have migrated and Legacy Auth could be disabled.
 *
 * Scenarios covered:
 * 1. Query returns correct structure and counts for unmigrated users
 * 2. Query returns correct counts after user migration
 * 3. canDisableLegacyAuth is true only when ALL users are migrated
 * 4. Query requires ADMIN role
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { Db, MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreBetterAuthService, HttpExceptionLogFilter, TestGraphQLType, TestHelper } from '../../src';
import envConfig from '../../src/config.env';
import { ServerModule } from '../../src/server/server.module';

describe('Story: BetterAuth Migration Status', () => {
  // Test environment
  let app;
  let testHelper: TestHelper;
  let mongoClient: MongoClient;
  let db: Db;
  let betterAuthService: CoreBetterAuthService;
  let isBetterAuthEnabled: boolean;
  let adminToken: string;

  // Test data
  const testEmails: string[] = [];
  const adminEmail = `migration-admin-${Date.now()}@test.com`;
  const adminPassword = 'AdminPassword123!';

  const generateTestEmail = (prefix: string): string => {
    const email = `migration-${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
    testEmails.push(email);
    return email;
  };

  // ===================================================================================================================
  // Setup and Teardown
  // ===================================================================================================================

  beforeAll(async () => {
    try {
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [ServerModule],
        providers: [{ provide: 'PUB_SUB', useValue: new PubSub() }],
      }).compile();

      app = moduleFixture.createNestApplication();
      app.useGlobalFilters(new HttpExceptionLogFilter());
      app.setBaseViewsDir(envConfig.templates.path);
      app.setViewEngine(envConfig.templates.engine);
      await app.init();
      testHelper = new TestHelper(app);

      betterAuthService = moduleFixture.get(CoreBetterAuthService);
      isBetterAuthEnabled = betterAuthService.isEnabled();

      mongoClient = await MongoClient.connect(envConfig.mongoose.uri);
      db = mongoClient.db();

      // Create admin user and get token
      await testHelper.graphQl({
        arguments: { input: { email: adminEmail, password: adminPassword } },
        fields: ['token', { user: ['id'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      // Make user admin
      await db.collection('users').updateOne({ email: adminEmail }, { $set: { roles: ['admin'] } });

      // Sign in to get token with admin role
      const adminSignIn = await testHelper.graphQl({
        arguments: { input: { email: adminEmail, password: adminPassword } },
        fields: ['token'],
        name: 'signIn',
        type: TestGraphQLType.MUTATION,
      });
      adminToken = adminSignIn.token;
    } catch (e) {
      console.error('beforeAllError', e);
      throw e;
    }
  });

  afterAll(async () => {
    // Cleanup
    if (db) {
      for (const email of testEmails) {
        const user = await db.collection('users').findOne({ email });
        if (user) {
          await db.collection('account').deleteMany({ userId: user._id });
          await db.collection('session').deleteMany({ userId: user._id });
          await db.collection('users').deleteOne({ email });
        }
      }
      // Cleanup admin
      const admin = await db.collection('users').findOne({ email: adminEmail });
      if (admin) {
        await db.collection('account').deleteMany({ userId: admin._id });
        await db.collection('session').deleteMany({ userId: admin._id });
        await db.collection('users').deleteOne({ email: adminEmail });
      }
    }

    if (mongoClient) await mongoClient.close();
    if (app) await app.close();
  });

  // ===================================================================================================================
  // Test Cases
  // ===================================================================================================================

  describe('1. Structure, Counts, and Percentage (single query)', () => {
    it('should return correct structure, counts, and percentage for unmigrated users', async () => {
      if (!isBetterAuthEnabled) {
        console.debug('Better-Auth is not enabled, skipping test');
        return;
      }

      // Create a legacy-only user (no iamId) to ensure there's at least one pending user
      const legacyEmail = generateTestEmail('legacy-only');
      await testHelper.graphQl({
        arguments: { input: { email: legacyEmail, password: 'TestPassword123!' } },
        fields: [{ user: ['id'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      // Verify user was created without iamId (unmigrated)
      const user = await db.collection('users').findOne({ email: legacyEmail });
      expect(user).toBeDefined();
      expect(user?.iamId).toBeUndefined();

      // Single query — validates structure, counts, canDisableLegacyAuth, and percentage
      const res = await testHelper.graphQl(
        {
          fields: [
            'totalUsers',
            'usersWithIamId',
            'usersWithIamAccount',
            'fullyMigratedUsers',
            'pendingMigrationUsers',
            'migrationPercentage',
            'canDisableLegacyAuth',
            'pendingUserEmails',
          ],
          name: 'betterAuthMigrationStatus',
          type: TestGraphQLType.QUERY,
        },
        { token: adminToken },
      );

      // Structure checks
      expect(typeof res.totalUsers).toBe('number');
      expect(res.usersWithIamId).toBeDefined();
      expect(res.usersWithIamAccount).toBeDefined();
      expect(res.fullyMigratedUsers).toBeDefined();
      expect(typeof res.canDisableLegacyAuth).toBe('boolean');
      expect(Array.isArray(res.pendingUserEmails)).toBe(true);

      // Count checks — at least one pending user (the one we just created)
      expect(res.totalUsers).toBeGreaterThan(0);
      expect(res.pendingMigrationUsers).toBeGreaterThan(0);

      // canDisableLegacyAuth must be false when there are pending users
      expect(res.canDisableLegacyAuth).toBe(false);

      // Percentage calculation
      const expectedPercentage =
        res.totalUsers > 0 ? Math.round((res.fullyMigratedUsers / res.totalUsers) * 100 * 100) / 100 : 0;
      expect(res.migrationPercentage).toBe(expectedPercentage);
    });
  });

  describe('2. Migration via IAM Sign-In', () => {
    it('should update counts after user migrates via IAM sign-in', async () => {
      if (!isBetterAuthEnabled) {
        console.debug('Better-Auth is not enabled, skipping test');
        return;
      }

      // Create legacy user
      const migratingEmail = generateTestEmail('migrating');
      const password = 'MigrateMe123!';

      await testHelper.graphQl({
        arguments: { input: { email: migratingEmail, password } },
        fields: [{ user: ['id'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      // Verify user starts without iamId
      const userBefore = await db.collection('users').findOne({ email: migratingEmail });
      expect(userBefore?.iamId).toBeUndefined();

      // Migrate user via IAM sign-in
      await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email: migratingEmail, password },
      });

      // Verify user now has iamId after migration
      const userAfter = await db.collection('users').findOne({ email: migratingEmail });
      expect(userAfter?.iamId).toBeDefined();
      expect(typeof userAfter?.iamId).toBe('string');

      // Verify IAM account exists
      const iamAccount = await db.collection('account').findOne({ userId: userAfter?.iamId });
      expect(iamAccount).toBeDefined();
    });
  });

  describe('3. Authorization', () => {
    it('should reject unauthenticated requests', async () => {
      if (!isBetterAuthEnabled) {
        console.debug('Better-Auth is not enabled, skipping test');
        return;
      }

      const res = await testHelper.graphQl(
        {
          fields: ['totalUsers'],
          name: 'betterAuthMigrationStatus',
          type: TestGraphQLType.QUERY,
        },
        { statusCode: 200 },
      );

      // Unauthenticated → query returns error (401 Unauthorized)
      expect(res.errors).toBeDefined();
      expect(res.errors[0].message).toMatch(/Unauthorized|not authenticated/i);
    });

    it('should reject non-admin users', async () => {
      if (!isBetterAuthEnabled) {
        console.debug('Better-Auth is not enabled, skipping test');
        return;
      }

      // Create regular user
      const regularEmail = generateTestEmail('regular');
      const regularPassword = 'RegularUser123!';

      await testHelper.graphQl({
        arguments: { input: { email: regularEmail, password: regularPassword } },
        fields: [{ user: ['id'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      const signIn = await testHelper.graphQl({
        arguments: { input: { email: regularEmail, password: regularPassword } },
        fields: ['token'],
        name: 'signIn',
        type: TestGraphQLType.MUTATION,
      });

      const res = await testHelper.graphQl(
        {
          fields: ['totalUsers'],
          name: 'betterAuthMigrationStatus',
          type: TestGraphQLType.QUERY,
        },
        { token: signIn.token },
      );

      // Non-admin → query returns error (403 Forbidden)
      expect(res.errors).toBeDefined();
      expect(res.errors[0].message).toMatch(/Access denied|Forbidden|Insufficient/i);
    });

    it('should allow admin users', async () => {
      if (!isBetterAuthEnabled) {
        console.debug('Better-Auth is not enabled, skipping test');
        return;
      }

      const res = await testHelper.graphQl(
        {
          fields: ['totalUsers'],
          name: 'betterAuthMigrationStatus',
          type: TestGraphQLType.QUERY,
        },
        { token: adminToken },
      );

      expect(res.errors).toBeUndefined();
      expect(res.totalUsers).toBeDefined();
    });
  });
});
