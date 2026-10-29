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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreBetterAuthService, HttpExceptionLogFilter, TestGraphQLType, TestHelper } from '../../src';
import envConfig from '../../src/config.env';
import { ServerModule } from '../../src/server/server.module';
import { type IamTestDb, openIamTestDb } from '../helpers/iam-test-db';

describe('Story: BetterAuth Migration Status', () => {
  // Test environment
  let app;
  let testHelper: TestHelper;
  // The database the run routes the users to (MongoDB, or PostgreSQL in the iam-sql projects)
  let iamDb: IamTestDb;
  let betterAuthService: CoreBetterAuthService;
  let isBetterAuthEnabled: boolean;
  let adminToken: string;

  // Test data — unique suffix guards against collisions with parallel test files
  // (process.pid + Date.now() + random salt — not Date.now() alone, which can collide
  // across forks that start in the same millisecond).
  const testEmails: string[] = [];
  const uniqueSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
  const adminEmail = `migration-admin-${uniqueSuffix}@test.com`;
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

      iamDb = await openIamTestDb(envConfig.mongoose.uri);

      // Create admin user and get token
      await testHelper.graphQl({
        arguments: { input: { email: adminEmail, password: adminPassword } },
        fields: ['token', { user: ['id'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      // Make user admin
      await iamDb.updateUser({ email: adminEmail }, { roles: ['admin'] });

      // Sign in to get token with admin role
      const adminSignIn = await testHelper.graphQl({
        arguments: { input: { email: adminEmail, password: adminPassword } },
        fields: ['token'],
        name: 'signIn',
        type: TestGraphQLType.MUTATION,
      });
      adminToken = adminSignIn.token;

      // Fail-fast: if admin token is missing (e.g. rate-limited signIn, config drift to
      // cookies-only mode by a parallel test, etc.), subsequent tests would fail with
      // cryptic "Invalid token" or "totalUsers is undefined" errors. Surface the root
      // cause here instead.
      if (!adminToken) {
        throw new Error(`beforeAll: adminSignIn returned no token. Response: ${JSON.stringify(adminSignIn)}`);
      }
    } catch (e) {
      console.error('beforeAllError', e);
      throw e;
    }
  });

  afterAll(async () => {
    // Cleanup
    // Users and everything Better-Auth keeps for them (sessions, accounts)
    if (iamDb) {
      for (const email of [...testEmails, adminEmail]) {
        await iamDb.deleteUsers({ email });
      }
      await iamDb.close();
    }

    if (app) await app.close();
  });

  // ===================================================================================================================
  // Test Cases
  // ===================================================================================================================

  describe('1. Structure, Counts, and Percentage (single query)', () => {
    /**
     * @regression   DEV-3831 (db-agnostic phase 3) — the migration status counted users and credential accounts with
     *   MongoDB aggregations, so with the users on PostgreSQL it reported an empty user base.
     * @seen-failing Skip the SQL branch of CoreBetterAuthUserMapper.getMigrationStatus() in
     *   src/core/modules/better-auth/core-better-auth-user.mapper.ts — registered as mutation
     *   `iam-migration-status-on-mongo` in tests/regression-mutations.json.
     */
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
      const user = await iamDb.findUser({ email: legacyEmail });
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

      // Structure checks — all counters are non-negative numbers
      expect(typeof res.totalUsers).toBe('number');
      expect(res.totalUsers).toBeGreaterThanOrEqual(0);
      expect(typeof res.usersWithIamId).toBe('number');
      expect(res.usersWithIamId).toBeGreaterThanOrEqual(0);
      expect(typeof res.usersWithIamAccount).toBe('number');
      expect(res.usersWithIamAccount).toBeGreaterThanOrEqual(0);
      expect(typeof res.fullyMigratedUsers).toBe('number');
      expect(res.fullyMigratedUsers).toBeGreaterThanOrEqual(0);
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

  describe('1b. Counts beyond one page', () => {
    /**
     * @regression   DEV-3831 (db-agnostic phase 3) — on SQL the status read the credential accounts through
     *   Better-Auth's `findMany()`, which stops at 100 rows without a limit: never more than 100 migrated users,
     *   `canDisableLegacyAuth` never true, and a boot warning telling operators to keep legacy auth open.
     * @seen-failing Count over one page of 100 rows in BetterAuthSqlStore.migrationCounts() in
     *   src/core/modules/better-auth/core-better-auth-sql.store.ts — registered as mutation
     *   `iam-migration-status-capped-at-a-page` in tests/regression-mutations.json.
     */
    it('counts every migrated user, not a page of them', async () => {
      if (!isBetterAuthEnabled) {
        return;
      }
      const prefix = `migration-bulk-${uniqueSuffix}`;
      for (let index = 0; index < 101; index++) {
        const email = `${prefix}-${index}@test.com`;
        testEmails.push(email);
        const id = await iamDb.insertUser({ email, roles: [] });
        await iamDb.updateUser({ id }, { iamId: id });
        await iamDb.insertCredentialAccount(id);
      }

      const res = await testHelper.graphQl(
        {
          fields: ['fullyMigratedUsers', 'usersWithIamAccount', 'pendingUserEmails'],
          name: 'betterAuthMigrationStatus',
          type: TestGraphQLType.QUERY,
        },
        { token: adminToken },
      );

      expect(res.fullyMigratedUsers).toBeGreaterThanOrEqual(101);
      expect(res.usersWithIamAccount).toBeGreaterThanOrEqual(101);
      expect(res.pendingUserEmails.filter((email: string) => email.startsWith(prefix))).toEqual([]);
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
      const userBefore = await iamDb.findUser({ email: migratingEmail });
      expect(userBefore?.iamId).toBeUndefined();

      // Migrate user via IAM sign-in
      await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email: migratingEmail, password },
      });

      // Verify user now has iamId after migration
      const userAfter = await iamDb.findUser({ email: migratingEmail });
      expect(userAfter?.iamId).toBeDefined();
      expect(typeof userAfter?.iamId).toBe('string');

      // Verify IAM account exists
      const iamAccount = await iamDb.credentialAccount(userAfter?.iamId);
      expect(iamAccount).not.toBeNull();
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
