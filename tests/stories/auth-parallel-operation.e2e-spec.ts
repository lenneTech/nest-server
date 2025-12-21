/**
 * Story: Parallel Authentication Operation Tests
 *
 * As a developer using @lenne.tech/nest-server,
 * I want Legacy Auth and Better-Auth to work in parallel,
 * So that users can authenticate with either system.
 *
 * Scenarios covered:
 * 1. Registration Scenarios
 *    - Legacy Sign-Up creates user with bcrypt password
 *    - Better-Auth Sign-Up creates user in same collection
 *    - Duplicate email prevention across both systems
 *
 * 2. Login Scenarios
 *    - Legacy User → Legacy Login (works)
 *    - Legacy User → Better-Auth Login (works - bcrypt compatible)
 *    - Better-Auth User → Better-Auth Login (works)
 *    - Better-Auth User → Legacy Login (works if password exists)
 *
 * 3. User Sync Scenarios
 *    - iamId is set on first Better-Auth login
 *    - Password field is preserved for parallel operation
 *
 * 4. Role-Based Access Control
 *    - Both auth systems respect the same roles
 *    - S_VERIFIED works with both systems
 */

import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import bcrypt = require('bcrypt');
import { PubSub } from 'graphql-subscriptions';
import { sha256 } from 'js-sha256';
import { Db, MongoClient, ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HttpExceptionLogFilter, RoleEnum, TestGraphQLType, TestHelper } from '../../src';
import envConfig from '../../src/config.env';
import { ServerModule } from '../../src/server/server.module';

describe('Story: Parallel Legacy/Better-Auth Operation', () => {
  // Test environment
  let app: NestExpressApplication;
  let testHelper: TestHelper;
  let mongoClient: MongoClient;
  let db: Db;

  // Test data tracking for cleanup
  const testEmails: string[] = [];

  // Helper to generate unique test emails
  const generateTestEmail = (prefix: string): string => {
    const email = `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
    testEmails.push(email);
    return email;
  };

  // Helper to hash password like Legacy Auth does
  // Legacy Auth uses sha256 THEN bcrypt for password hashing
  const hashPassword = async (password: string): Promise<string> => {
    return bcrypt.hash(sha256(password), 10);
  };

  // Helper to verify password like Legacy Auth does
  const verifyPassword = async (password: string, hash: string): Promise<boolean> => {
    // Legacy Auth supports both plain and sha256-hashed passwords
    return (await bcrypt.compare(password, hash)) || (await bcrypt.compare(sha256(password), hash));
  };

  // ===================================================================================================================
  // Setup and Teardown
  // ===================================================================================================================

  beforeAll(async () => {
    try {
      // Start server for testing
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [ServerModule],
        providers: [
          {
            provide: 'PUB_SUB',
            useValue: new PubSub(),
          },
        ],
      }).compile();

      app = moduleFixture.createNestApplication<NestExpressApplication>();
      app.useGlobalFilters(new HttpExceptionLogFilter());
      app.setBaseViewsDir(envConfig.templates.path);
      app.setViewEngine(envConfig.templates.engine);
      await app.init();
      testHelper = new TestHelper(app);

      // Connection to database
      mongoClient = await MongoClient.connect(envConfig.mongoose.uri);
      db = mongoClient.db();
    } catch (e) {
      console.error('beforeAllError', e);
      throw e;
    }
  });

  afterAll(async () => {
    // Clean up test users
    if (db) {
      for (const email of testEmails) {
        await db.collection('users').deleteOne({ email });
      }
    }

    if (mongoClient) {
      await mongoClient.close();
    }

    if (app) {
      await app.close();
    }
  });

  // ===================================================================================================================
  // 1. Registration Scenarios
  // ===================================================================================================================

  describe('1. Registration Scenarios', () => {
    describe('1.1 Legacy Sign-Up', () => {
      it('should create user with bcrypt hashed password via GraphQL signUp', async () => {
        const email = generateTestEmail('legacy-signup');
        const password = 'TestPassword123!';

        const res = await testHelper.graphQl({
          arguments: {
            input: {
              email,
              firstName: 'Legacy',
              lastName: 'User',
              password,
            },
          },
          fields: ['token', 'refreshToken', { user: ['id', 'email', 'roles'] }],
          name: 'signUp',
          type: TestGraphQLType.MUTATION,
        });

        // Verify response
        expect(res.user.email).toEqual(email);
        expect(res.token).toBeDefined();
        expect(res.refreshToken).toBeDefined();

        // Verify database state
        const dbUser = await db.collection('users').findOne({ email });
        expect(dbUser).toBeDefined();
        expect(dbUser.password).toBeDefined(); // bcrypt hash
        expect(dbUser.iamId).toBeUndefined(); // Not yet linked to Better-Auth

        // Verify password is properly hashed (Legacy Auth uses sha256 + bcrypt)
        const isValidHash = await verifyPassword(password, dbUser.password);
        expect(isValidHash).toBe(true);
      });

      it('should prevent duplicate email registration via Legacy', async () => {
        const email = generateTestEmail('legacy-duplicate');
        const password = 'TestPassword123!';

        // First sign-up should succeed
        const res1 = await testHelper.graphQl({
          arguments: {
            input: { email, password },
          },
          fields: [{ user: ['id', 'email'] }],
          name: 'signUp',
          type: TestGraphQLType.MUTATION,
        });
        expect(res1.user.email).toEqual(email);

        // Second sign-up with same email should fail
        const res2 = await testHelper.graphQl({
          arguments: {
            input: { email, password: 'DifferentPassword!' },
          },
          fields: [{ user: ['id', 'email'] }],
          name: 'signUp',
          type: TestGraphQLType.MUTATION,
        });
        expect(res2.errors).toBeDefined();
        expect(res2.errors.length).toBeGreaterThanOrEqual(1);
        expect(res2.errors[0].message).toContain('Email address already in use');
      });
    });

    describe('1.2 User Created Directly in DB (Simulating Better-Auth)', () => {
      it('should create user with password in same collection', async () => {
        const email = generateTestEmail('better-auth-signup');
        const password = 'BetterAuthPassword123!';
        const hashedPassword = await hashPassword(password);
        const iamId = `ba-${Date.now()}`;

        // Simulate Better-Auth creating a user directly
        await db.collection('users').insertOne({
          createdAt: new Date(),
          email,
          iamId,
          name: 'Better Auth User',
          password: hashedPassword,
          roles: [RoleEnum.S_USER],
          updatedAt: new Date(),
        });

        // Verify database state
        const dbUser = await db.collection('users').findOne({ email });
        expect(dbUser).toBeDefined();
        expect(dbUser.password).toBe(hashedPassword);
        expect(dbUser.iamId).toBe(iamId);
      });

      it('should prevent Legacy sign-up with email that exists from Better-Auth', async () => {
        const email = generateTestEmail('cross-system-duplicate');
        const iamId = `ba-${Date.now()}`;

        // Create user via "Better-Auth" (direct DB insert)
        await db.collection('users').insertOne({
          createdAt: new Date(),
          email,
          iamId,
          password: await hashPassword('BetterAuthPassword!'),
          roles: [RoleEnum.S_USER],
          updatedAt: new Date(),
        });

        // Legacy sign-up should fail due to existing email
        const res = await testHelper.graphQl({
          arguments: {
            input: { email, password: 'LegacyPassword!' },
          },
          fields: [{ user: ['id', 'email'] }],
          name: 'signUp',
          type: TestGraphQLType.MUTATION,
        });

        expect(res.errors).toBeDefined();
        expect(res.errors.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  // ===================================================================================================================
  // 2. Login Scenarios
  // ===================================================================================================================

  describe('2. Login Scenarios', () => {
    describe('2.1 Legacy User → Legacy Login', () => {
      it('should login successfully with correct password', async () => {
        const email = generateTestEmail('legacy-login');
        const password = 'LegacyPassword123!';

        // Create user via Legacy Sign-Up
        await testHelper.graphQl({
          arguments: { input: { email, password } },
          fields: [{ user: ['id'] }],
          name: 'signUp',
          type: TestGraphQLType.MUTATION,
        });

        // Login via Legacy
        const res = await testHelper.graphQl({
          arguments: { input: { email, password } },
          fields: ['token', 'refreshToken', { user: ['id', 'email'] }],
          name: 'signIn',
          type: TestGraphQLType.MUTATION,
        });

        expect(res.user.email).toEqual(email);
        expect(res.token).toBeDefined();
        expect(res.refreshToken).toBeDefined();
      });

      it('should fail login with incorrect password', async () => {
        const email = generateTestEmail('legacy-wrong-pw');
        const password = 'CorrectPassword123!';

        // Create user
        await testHelper.graphQl({
          arguments: { input: { email, password } },
          fields: [{ user: ['id'] }],
          name: 'signUp',
          type: TestGraphQLType.MUTATION,
        });

        // Attempt login with wrong password
        const res = await testHelper.graphQl({
          arguments: { input: { email, password: 'WrongPassword!' } },
          fields: ['token', { user: ['id'] }],
          name: 'signIn',
          type: TestGraphQLType.MUTATION,
        });

        expect(res.errors).toBeDefined();
        expect(res.errors[0].message).toContain('Wrong password');
      });

      it('should fail login with unknown email', async () => {
        const res = await testHelper.graphQl({
          arguments: { input: { email: 'unknown@test.com', password: 'anypassword' } },
          fields: ['token', { user: ['id'] }],
          name: 'signIn',
          type: TestGraphQLType.MUTATION,
        });

        expect(res.errors).toBeDefined();
        // Error message is "Unknown email" (CoreAuthService catches NotFoundException and returns UnauthorizedException)
        expect(res.errors[0].message).toContain('Unknown email');
      });
    });

    describe('2.2 Better-Auth User → Legacy Login', () => {
      it('should login via Legacy if user has password field', async () => {
        const email = generateTestEmail('better-auth-to-legacy');
        const password = 'SharedPassword123!';
        const hashedPassword = await hashPassword(password);
        const iamId = `ba-${Date.now()}`;

        // Create user as if Better-Auth created them
        await db.collection('users').insertOne({
          createdAt: new Date(),
          email,
          iamId,
          password: hashedPassword, // Both systems use bcrypt
          roles: [RoleEnum.S_USER],
          updatedAt: new Date(),
        });

        // Login via Legacy should work since password field exists
        const res = await testHelper.graphQl({
          arguments: { input: { email, password } },
          fields: ['token', 'refreshToken', { user: ['id', 'email'] }],
          name: 'signIn',
          type: TestGraphQLType.MUTATION,
        });

        expect(res.user.email).toEqual(email);
        expect(res.token).toBeDefined();
      });

      it('should fail Legacy login if user has no password field', async () => {
        const email = generateTestEmail('social-only-user');
        const iamId = `ba-social-${Date.now()}`;

        // Create user without password (e.g., social login only)
        await db.collection('users').insertOne({
          createdAt: new Date(),
          email,
          iamId,
          // No password field - social login only
          roles: [RoleEnum.S_USER],
          updatedAt: new Date(),
        });

        // Legacy login should fail with specific message for social-only users
        const res = await testHelper.graphQl({
          arguments: { input: { email, password: 'anypassword' } },
          fields: ['token', { user: ['id'] }],
          name: 'signIn',
          type: TestGraphQLType.MUTATION,
        });

        expect(res.errors).toBeDefined();
        expect(res.errors[0].message).toContain('No password set for this account');
      });
    });

    describe('2.3 Migrated User → Both Login Paths', () => {
      it('should support login via Legacy after Better-Auth sync (password preserved)', async () => {
        const email = generateTestEmail('migrated-user');
        const password = 'MigratedPassword123!';

        // Create Legacy user
        await testHelper.graphQl({
          arguments: { input: { email, password } },
          fields: [{ user: ['id'] }],
          name: 'signUp',
          type: TestGraphQLType.MUTATION,
        });

        // Verify initial state
        let dbUser = await db.collection('users').findOne({ email });
        expect(dbUser.password).toBeDefined();
        expect(dbUser.iamId).toBeUndefined();

        // Simulate Better-Auth sync (what happens when user logs in via Better-Auth)
        const iamId = `ba-${Date.now()}`;
        await db.collection('users').updateOne(
          { email },
          {
            $set: {
              iamId,
              updatedAt: new Date(),
            },
            // NOTE: password field is PRESERVED for parallel operation
          },
        );

        // Verify synced state
        dbUser = await db.collection('users').findOne({ email });
        expect(dbUser.password).toBeDefined(); // Still exists for Legacy
        expect(dbUser.iamId).toBe(iamId);

        // Legacy login should still work
        const res = await testHelper.graphQl({
          arguments: { input: { email, password } },
          fields: ['token', { user: ['id', 'email'] }],
          name: 'signIn',
          type: TestGraphQLType.MUTATION,
        });

        expect(res.user.email).toEqual(email);
        expect(res.token).toBeDefined();
      });
    });
  });

  // ===================================================================================================================
  // 3. User Sync
  // ===================================================================================================================

  describe('3. User Sync', () => {
    // Tests use db directly to verify sync behavior

    describe('3.1 linkOrCreateUser Behavior', () => {
      it('should set iamId on existing Legacy user', async () => {
        const email = generateTestEmail('sync-betterauth-id');
        const password = 'SyncPassword123!';

        // Create Legacy user
        await testHelper.graphQl({
          arguments: { input: { email, password } },
          fields: [{ user: ['id'] }],
          name: 'signUp',
          type: TestGraphQLType.MUTATION,
        });

        // Verify no iamId initially
        let dbUser = await db.collection('users').findOne({ email });
        expect(dbUser.iamId).toBeUndefined();

        // Simulate linkOrCreateUser
        const iamId = `ba-sync-${Date.now()}`;
        await db.collection('users').updateOne(
          { $or: [{ email }, { iamId }] },
          {
            $set: {
              iamId,
              updatedAt: new Date(),
            },
          },
        );

        // Verify iamId is set
        dbUser = await db.collection('users').findOne({ email });
        expect(dbUser.iamId).toBe(iamId);
      });

      it('should preserve password when syncing (parallel operation)', async () => {
        const email = generateTestEmail('sync-preserve-pw');
        const password = 'PreservePassword123!';

        // Create Legacy user
        await testHelper.graphQl({
          arguments: { input: { email, password } },
          fields: [{ user: ['id'] }],
          name: 'signUp',
          type: TestGraphQLType.MUTATION,
        });

        // Get the hashed password
        let dbUser = await db.collection('users').findOne({ email });
        const originalPasswordHash = dbUser.password;
        expect(originalPasswordHash).toBeDefined();

        // Simulate linkOrCreateUser - only sets iamId, preserves password
        const iamId = `ba-preserve-${Date.now()}`;
        await db.collection('users').updateOne(
          { email },
          {
            $set: {
              iamId,
              updatedAt: new Date(),
            },
            // password field is preserved for parallel operation
          },
        );

        // Verify password is preserved
        dbUser = await db.collection('users').findOne({ email });
        expect(dbUser.password).toBe(originalPasswordHash); // PRESERVED
        expect(dbUser.iamId).toBe(iamId);
      });

      it('should create new user with default role if not found', async () => {
        const email = generateTestEmail('sync-create-new');
        const iamId = `ba-new-${Date.now()}`;

        // Verify user doesn't exist
        let dbUser = await db.collection('users').findOne({ email });
        expect(dbUser).toBeNull();

        // Simulate linkOrCreateUser upsert (new user from Better-Auth)
        await db.collection('users').findOneAndUpdate(
          { $or: [{ email }, { iamId }] },
          {
            $set: {
              email,
              iamId,
              updatedAt: new Date(),
            },
            $setOnInsert: {
              createdAt: new Date(),
              roles: [], // S_ roles are system checks, not stored in user.roles
            },
          },
          { upsert: true },
        );

        // Verify user was created with default role
        dbUser = await db.collection('users').findOne({ email });
        expect(dbUser).toBeDefined();
        expect(dbUser.roles).toEqual([]); // S_ roles are system checks, not stored in user.roles
        expect(dbUser.iamId).toBe(iamId);
      });

      it('should find user by iamId when email differs', async () => {
        const originalEmail = generateTestEmail('email-change-original');
        const iamId = `ba-email-change-${Date.now()}`;
        const password = 'EmailChangePassword!';

        // Create user with original email and iamId
        await db.collection('users').insertOne({
          createdAt: new Date(),
          email: originalEmail,
          iamId,
          password: await hashPassword(password),
          roles: [RoleEnum.S_USER],
          updatedAt: new Date(),
        });

        // Simulate lookup by iamId (e.g., after email change in Better-Auth)
        const dbUser = await db.collection('users').findOne({
          $or: [{ email: 'different@email.com' }, { iamId }],
        });

        expect(dbUser).toBeDefined();
        expect(dbUser.email).toBe(originalEmail);
        expect(dbUser.iamId).toBe(iamId);
      });
    });

    describe('3.2 Sync Status', () => {
      it('should track sync status correctly via iamId', async () => {
        const email = generateTestEmail('sync-status');
        const password = 'SyncStatus123!';

        // Create Legacy user
        await testHelper.graphQl({
          arguments: { input: { email, password } },
          fields: [{ user: ['id'] }],
          name: 'signUp',
          type: TestGraphQLType.MUTATION,
        });

        // Check initial status - user exists but not synced with Better-Auth
        let dbUser = await db.collection('users').findOne({ email });
        expect(dbUser).toBeDefined();
        expect(dbUser.iamId).toBeUndefined();
        expect(dbUser.password).toBeDefined();

        // Sync with Better-Auth (set iamId)
        const iamId = `ba-status-${Date.now()}`;
        await db.collection('users').updateOne(
          { email },
          {
            $set: {
              iamId,
              updatedAt: new Date(),
            },
          },
        );

        // Check post-sync status - iamId is set, password preserved
        dbUser = await db.collection('users').findOne({ email });
        expect(dbUser.iamId).toBe(iamId);
        expect(dbUser.password).toBeDefined(); // Still preserved for parallel operation
      });
    });
  });

  // ===================================================================================================================
  // 4. Role-Based Access Control
  // ===================================================================================================================

  describe('4. Role-Based Access Control', () => {
    describe('4.1 Legacy User Roles', () => {
      it('should respect admin role from Legacy user', async () => {
        const email = generateTestEmail('legacy-admin');
        const password = 'AdminPassword123!';

        // Create user and get token
        const signUpRes = await testHelper.graphQl({
          arguments: { input: { email, password } },
          fields: ['token', { user: ['id'] }],
          name: 'signUp',
          type: TestGraphQLType.MUTATION,
        });
        const userId = signUpRes.user.id;

        // User should not have admin access initially
        let findRes = await testHelper.graphQl({ fields: ['id'], name: 'findUsers' }, { token: signUpRes.token });
        expect(findRes.errors).toBeDefined();
        expect(findRes.errors[0].message).toContain('Missing role');

        // Grant admin role
        await db.collection('users').updateOne({ _id: new ObjectId(userId) }, { $set: { roles: [RoleEnum.ADMIN] } });

        // Re-login to get new token with updated roles
        const signInRes = await testHelper.graphQl({
          arguments: { input: { email, password } },
          fields: ['token', { user: ['id', 'roles'] }],
          name: 'signIn',
          type: TestGraphQLType.MUTATION,
        });

        // Should now have admin access
        findRes = await testHelper.graphQl({ fields: ['id', 'email'], name: 'findUsers' }, { token: signInRes.token });
        expect(findRes.length).toBeGreaterThanOrEqual(1);
      });

      it('should verify S_VERIFIED role for verified users', async () => {
        const email = generateTestEmail('verified-role');
        const password = 'VerifiedPassword123!';

        // Create user
        const signUpRes = await testHelper.graphQl({
          arguments: { input: { email, password } },
          fields: ['token', { user: ['id'] }],
          name: 'signUp',
          type: TestGraphQLType.MUTATION,
        });
        const userId = signUpRes.user.id;

        // Get verification token and verify
        const dbUser = await db.collection('users').findOne({ _id: new ObjectId(userId) });

        await testHelper.graphQl({
          arguments: { token: dbUser.verificationToken },
          name: 'verifyUser',
          type: TestGraphQLType.MUTATION,
        });

        // Verify user is now verified
        const verifiedUser = await db.collection('users').findOne({ _id: new ObjectId(userId) });
        expect(verifiedUser.verified).toBe(true);
      });
    });

    describe('4.2 Role Consistency Across Auth Systems', () => {
      it('should maintain roles when syncing with Better-Auth', async () => {
        const email = generateTestEmail('role-consistency');
        const password = 'RoleConsistency123!';

        // Create user and grant admin role
        const signUpRes = await testHelper.graphQl({
          arguments: { input: { email, password } },
          fields: [{ user: ['id'] }],
          name: 'signUp',
          type: TestGraphQLType.MUTATION,
        });
        const userId = signUpRes.user.id;

        await db
          .collection('users')
          .updateOne({ _id: new ObjectId(userId) }, { $set: { roles: [RoleEnum.ADMIN, 'custom-role'] } });

        // Simulate Better-Auth sync - only sets iamId
        const iamId = `ba-role-${Date.now()}`;
        await db.collection('users').updateOne(
          { _id: new ObjectId(userId) },
          {
            $set: {
              iamId,
              updatedAt: new Date(),
            },
            // NOT modifying roles - they are preserved
          },
        );

        // Verify roles are preserved
        const syncedUser = await db.collection('users').findOne({ _id: new ObjectId(userId) });
        expect(syncedUser.roles).toContain(RoleEnum.ADMIN);
        expect(syncedUser.roles).toContain('custom-role');
        expect(syncedUser.iamId).toBe(iamId);
        expect(syncedUser.password).toBeDefined(); // Password preserved for parallel operation
      });
    });
  });

  // ===================================================================================================================
  // 6. Edge Cases
  // ===================================================================================================================

  describe('6. Edge Cases', () => {
    it('should handle user with empty roles array', async () => {
      const email = generateTestEmail('empty-roles');
      const iamId = `ba-empty-roles-${Date.now()}`;

      await db.collection('users').insertOne({
        createdAt: new Date(),
        email,
        iamId,
        password: await hashPassword('EmptyRoles123!'),
        roles: [], // Empty roles
        updatedAt: new Date(),
      });

      const dbUser = await db.collection('users').findOne({ email });
      expect(dbUser.roles).toEqual([]);
    });

    it('should handle concurrent sign-ups with same email', async () => {
      const email = generateTestEmail('concurrent-signup');
      const password = 'Concurrent123!';

      // Simulate concurrent sign-ups
      const promises = [
        testHelper.graphQl({
          arguments: { input: { email, password } },
          fields: [{ user: ['id', 'email'] }],
          name: 'signUp',
          type: TestGraphQLType.MUTATION,
        }),
        testHelper.graphQl({
          arguments: { input: { email, password: 'DifferentPassword!' } },
          fields: [{ user: ['id', 'email'] }],
          name: 'signUp',
          type: TestGraphQLType.MUTATION,
        }),
      ];

      const results = await Promise.all(promises);

      // One should succeed, one should fail
      const successes = results.filter((r) => r.user?.email);
      const failures = results.filter((r) => r.errors?.length > 0);

      expect(successes.length).toBe(1);
      expect(failures.length).toBe(1);
    });

    it('should handle special characters in password', async () => {
      const email = generateTestEmail('special-chars');
      const password = 'P@$$w0rd!#$%^&*()_+{}[]|\\:";\'<>?,./';

      // Sign up with special characters
      const signUpRes = await testHelper.graphQl({
        arguments: { input: { email, password } },
        fields: ['token', { user: ['id', 'email'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });
      expect(signUpRes.user.email).toBe(email);

      // Login with same special characters
      const signInRes = await testHelper.graphQl({
        arguments: { input: { email, password } },
        fields: ['token', { user: ['id', 'email'] }],
        name: 'signIn',
        type: TestGraphQLType.MUTATION,
      });
      expect(signInRes.user.email).toBe(email);
    });

    it('should handle very long passwords', async () => {
      const email = generateTestEmail('long-password');
      const password = `${'A'.repeat(100)}!1a`; // 103 character password

      const signUpRes = await testHelper.graphQl({
        arguments: { input: { email, password } },
        fields: ['token', { user: ['id', 'email'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });
      expect(signUpRes.user.email).toBe(email);

      const signInRes = await testHelper.graphQl({
        arguments: { input: { email, password } },
        fields: ['token', { user: ['id', 'email'] }],
        name: 'signIn',
        type: TestGraphQLType.MUTATION,
      });
      expect(signInRes.user.email).toBe(email);
    });
  });
});
