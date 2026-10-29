/**
 * Story: Bidirectional Auth Sync Tests
 *
 * As a developer using @lenne.tech/nest-server,
 * I want users to be able to sign up with one auth system (Legacy or IAM)
 * and then sign in with either system,
 * So that users have a seamless experience regardless of which auth method they use.
 *
 * Scenarios covered:
 * 1. IAM Sign-Up → Legacy Sign-In
 *    - User signs up via Better-Auth (IAM)
 *    - Password is synced to users.password
 *    - User can then sign in via Legacy Auth (GraphQL signIn)
 *
 * 2. Legacy Sign-Up → IAM Sign-In
 *    - User signs up via Legacy Auth (GraphQL signUp)
 *    - When attempting IAM sign-in, account is automatically migrated
 *    - User can sign in via Better-Auth (REST /iam/sign-in/email)
 *
 * Prerequisites:
 * - Better-Auth must be enabled for these tests to run
 *
 * The 11.37.0 issuer defect this suite used to pin only exists on better-auth 1.7.0–1.7.2, which
 * this repository no longer installs; it is pinned by unit specs that simulate that line
 * (tests/unit/better-auth-account-issuer-writes.spec.ts).
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CoreBetterAuthService,
  CoreBetterAuthUserMapper,
  HttpExceptionLogFilter,
  TestGraphQLType,
  TestHelper,
} from '../../src';
import envConfig from '../../src/config.env';
import { ServerModule } from '../../src/server/server.module';
import { type IamTestDb, openIamTestDb } from '../helpers/iam-test-db';

describe('Story: Bidirectional Auth Sync', () => {
  // Test environment
  let app;
  let testHelper: TestHelper;
  // The database the run routes the users to (MongoDB, or PostgreSQL in the iam-sql projects)
  let iamDb: IamTestDb;
  let betterAuthService: CoreBetterAuthService;
  let userMapper: CoreBetterAuthUserMapper;
  let isBetterAuthEnabled: boolean;

  // Test data tracking for cleanup
  const testEmails: string[] = [];
  const testIamUserIds: string[] = [];

  // Helper to generate unique test emails
  const generateTestEmail = (prefix: string): string => {
    const email = `bidir-${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
    testEmails.push(email);
    return email;
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

      app = moduleFixture.createNestApplication();
      app.useGlobalFilters(new HttpExceptionLogFilter());
      app.setBaseViewsDir(envConfig.templates.path);
      app.setViewEngine(envConfig.templates.engine);
      await app.init();
      testHelper = new TestHelper(app);

      // Get Better-Auth service and user mapper
      betterAuthService = moduleFixture.get(CoreBetterAuthService);
      userMapper = moduleFixture.get(CoreBetterAuthUserMapper);
      isBetterAuthEnabled = betterAuthService.isEnabled();

      // Connection to database
      iamDb = await openIamTestDb(envConfig.mongoose.uri);
    } catch (e) {
      console.error('beforeAllError', e);
      throw e;
    }
  });

  afterAll(async () => {
    // Clean up test users (filtered by userId to avoid interfering with parallel tests)
    if (iamDb) {
      for (const email of testEmails) {
        await iamDb.deleteUsers({ email });
      }
      await iamDb.deleteUsers({ ids: testIamUserIds });
      await iamDb.close();
    }

    if (app) {
      await app.close();
    }
  });

  // ===================================================================================================================
  // 1. IAM Sign-Up → Legacy Sign-In
  // ===================================================================================================================

  describe('1. IAM Sign-Up → Legacy Sign-In', () => {
    it('should sync password to users.password after IAM sign-up', async () => {
      if (!isBetterAuthEnabled) {
        console.debug('Better-Auth is not enabled, skipping test');
        return;
      }

      const email = generateTestEmail('iam-to-legacy');
      const password = 'IamToLegacy123!';

      // Sign up via Better-Auth (IAM) - returns 201 Created
      const signUpRes = await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'IAM User', password, termsAndPrivacyAccepted: true },
        statusCode: 201,
      });

      // Status is checked internally by testHelper.rest via statusCode option
      expect(signUpRes.success).toBe(true);
      expect(signUpRes.user).toBeDefined();

      // Track for cleanup
      if (signUpRes.user?.id) {
        testIamUserIds.push(signUpRes.user.id);
      }

      // Verify password was synced to users collection
      const dbUser = await iamDb.findUser({ email });
      expect(dbUser).toBeDefined();
      expect(dbUser!.password).toBeDefined();
      expect(typeof dbUser!.password).toBe('string');
      expect(dbUser!.password.length).toBeGreaterThan(10); // bcrypt hash is ~60 chars
    });

    it('should allow Legacy sign-in after IAM sign-up', async () => {
      if (!isBetterAuthEnabled) {
        console.debug('Better-Auth is not enabled, skipping test');
        return;
      }

      const email = generateTestEmail('iam-then-legacy');
      const password = 'CrossSystem123!';

      // Sign up via Better-Auth (IAM) - returns 201 Created
      const signUpRes = await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'Cross System User', password, termsAndPrivacyAccepted: true },
        statusCode: 201,
      });

      // Status is checked internally by testHelper.rest via statusCode option
      expect(signUpRes.success).toBe(true);

      // Track for cleanup
      if (signUpRes.user?.id) {
        testIamUserIds.push(signUpRes.user.id);
      }

      // Now sign in via Legacy Auth (GraphQL)
      const signInRes = await testHelper.graphQl({
        arguments: { input: { email, password } },
        fields: ['token', 'refreshToken', { user: ['id', 'email'] }],
        name: 'signIn',
        type: TestGraphQLType.MUTATION,
      });

      expect(signInRes.user).toBeDefined();
      expect(signInRes.user.email).toBe(email);
      expect(signInRes.token).toBeDefined();
      expect(signInRes.refreshToken).toBeDefined();
    });
  });

  // ===================================================================================================================
  // 2. Legacy Sign-Up → IAM Sign-In
  // ===================================================================================================================

  describe('2. Legacy Sign-Up → IAM Sign-In', () => {
    it('should automatically migrate Legacy user to IAM on first IAM sign-in', async () => {
      if (!isBetterAuthEnabled) {
        console.debug('Better-Auth is not enabled, skipping test');
        return;
      }

      const email = generateTestEmail('legacy-to-iam');
      const password = 'LegacyToIam123!';

      // Sign up via Legacy Auth (GraphQL)
      const signUpRes = await testHelper.graphQl({
        arguments: {
          input: {
            email,
            firstName: 'Legacy',
            lastName: 'User',
            password,
          },
        },
        fields: ['token', { user: ['id', 'email'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      expect(signUpRes.user).toBeDefined();
      expect(signUpRes.user.email).toBe(email);

      // Verify no IAM account exists yet (users collection is shared, account collection is Better-Auth specific)
      const userBefore = await iamDb.findUser({ email });
      expect(userBefore).toBeDefined();
      let iamAccount = await iamDb.credentialAccount(userBefore!.id);
      expect(iamAccount).toBeNull(); // No credential account before migration

      // Now sign in via Better-Auth (IAM) - should auto-migrate
      const signInRes = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password },
      });

      // Status is checked internally by testHelper.rest via statusCode option
      expect(signInRes.success).toBe(true);
      expect(signInRes.user).toBeDefined();
      expect(signInRes.user.email).toBe(email);

      // Track for cleanup
      if (signInRes.user?.id) {
        testIamUserIds.push(signInRes.user.id);
      }

      // Verify IAM account was created after migration
      const userAfter = await iamDb.findUser({ email });
      expect(userAfter).toBeDefined();
      expect(userAfter!.iamId).toBeDefined(); // iamId should be set after migration

      iamAccount = await iamDb.credentialAccount(userAfter!.id);
      expect(iamAccount).toBeDefined();
      expect(iamAccount!.password).toBeDefined();
    });

    it('should allow repeated sign-ins after migration', async () => {
      if (!isBetterAuthEnabled) {
        console.debug('Better-Auth is not enabled, skipping test');
        return;
      }

      const email = generateTestEmail('repeated-signin');
      const password = 'RepeatedSignIn123!';

      // Sign up via Legacy
      await testHelper.graphQl({
        arguments: { input: { email, password } },
        fields: [{ user: ['id'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      // First IAM sign-in (triggers migration)
      const signIn1 = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password },
      });
      // Status is checked internally by testHelper.rest via statusCode option
      expect(signIn1.success).toBe(true);

      // Track for cleanup
      if (signIn1.user?.id) {
        testIamUserIds.push(signIn1.user.id);
      }

      // Second IAM sign-in (should work without migration)
      const signIn2 = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password },
      });
      // Status is checked internally by testHelper.rest via statusCode option
      expect(signIn2.success).toBe(true);

      // Third IAM sign-in
      const signIn3 = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password },
      });
      // Status is checked internally by testHelper.rest via statusCode option
      expect(signIn3.success).toBe(true);
    });
  });

  // ===================================================================================================================
  // 3. Both Systems Working Together
  // ===================================================================================================================

  describe('3. Both Systems Working Together', () => {
    it('should allow alternating between Legacy and IAM sign-ins', async () => {
      if (!isBetterAuthEnabled) {
        console.debug('Better-Auth is not enabled, skipping test');
        return;
      }

      const email = generateTestEmail('alternating');
      const password = 'Alternating123!';

      // Sign up via Legacy
      await testHelper.graphQl({
        arguments: { input: { email, password } },
        fields: [{ user: ['id'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      // Sign in via Legacy
      const legacySignIn1 = await testHelper.graphQl({
        arguments: { input: { email, password } },
        fields: ['token', { user: ['email'] }],
        name: 'signIn',
        type: TestGraphQLType.MUTATION,
      });
      expect(legacySignIn1.user.email).toBe(email);

      // Sign in via IAM
      const iamSignIn1 = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password },
      });
      expect(iamSignIn1.success).toBe(true);

      // Track for cleanup
      if (iamSignIn1.user?.id) {
        testIamUserIds.push(iamSignIn1.user.id);
      }

      // Sign in via Legacy again
      const legacySignIn2 = await testHelper.graphQl({
        arguments: { input: { email, password } },
        fields: ['token', { user: ['email'] }],
        name: 'signIn',
        type: TestGraphQLType.MUTATION,
      });
      expect(legacySignIn2.user.email).toBe(email);

      // Sign in via IAM again
      const iamSignIn2 = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password },
      });
      expect(iamSignIn2.success).toBe(true);
    });

    /**
     * @regression   DEV-3831 (db-agnostic phase 3) — on SQL Better-Auth added `name` as a NOT NULL column, so every
     *   user the framework created without one (legacy sign-up, user service, setup) failed to insert.
     * @seen-failing Skip adding the required user columns nullable in addRequiredUserColumnsAsNullable() in
     *   src/core/modules/better-auth/better-auth-sql.helper.ts — registered as mutation
     *   `iam-required-user-column-not-null` in tests/regression-mutations.json.
     */
    it('should link iamId after IAM sign-in', async () => {
      if (!isBetterAuthEnabled) {
        console.debug('Better-Auth is not enabled, skipping test');
        return;
      }

      const email = generateTestEmail('iamid-link');
      const password = 'IamIdLink123!';

      // Sign up via Legacy
      await testHelper.graphQl({
        arguments: { input: { email, password } },
        fields: [{ user: ['id'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      // Verify no iamId initially
      let dbUser = await iamDb.findUser({ email });
      expect(dbUser!.iamId).toBeUndefined();

      // Sign in via IAM (triggers migration and linking)
      const iamSignIn = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password },
      });
      expect(iamSignIn.success).toBe(true);

      // Track for cleanup
      if (iamSignIn.user?.id) {
        testIamUserIds.push(iamSignIn.user.id);
      }

      // Verify iamId is now set
      dbUser = await iamDb.findUser({ email });
      expect(dbUser!.iamId).toBeDefined();
      expect(typeof dbUser!.iamId).toBe('string');
    });
  });

  // ===================================================================================================================
  // 4. Error Cases
  // ===================================================================================================================

  describe('4. Error Cases', () => {
    it('should reject wrong password for IAM sign-in after Legacy sign-up', async () => {
      if (!isBetterAuthEnabled) {
        console.debug('Better-Auth is not enabled, skipping test');
        return;
      }

      const email = generateTestEmail('wrong-password-iam');
      const correctPassword = 'CorrectPassword123!';
      const wrongPassword = 'WrongPassword123!';

      // Sign up via Legacy
      await testHelper.graphQl({
        arguments: { input: { email, password: correctPassword } },
        fields: [{ user: ['id'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      // Attempt IAM sign-in with wrong password - expect 401
      await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password: wrongPassword },
        statusCode: 401,
      });
    });

    it('should reject wrong password for Legacy sign-in after IAM sign-up', async () => {
      if (!isBetterAuthEnabled) {
        console.debug('Better-Auth is not enabled, skipping test');
        return;
      }

      const email = generateTestEmail('wrong-password-legacy');
      const correctPassword = 'CorrectPassword123!';
      const wrongPassword = 'WrongPassword123!';

      // Sign up via IAM (returns 201 Created)
      const signUpRes = await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'Test User', password: correctPassword, termsAndPrivacyAccepted: true },
        statusCode: 201,
      });
      expect(signUpRes.success).toBe(true);

      // Track for cleanup
      if (signUpRes.user?.id) {
        testIamUserIds.push(signUpRes.user.id);
      }

      // Attempt Legacy sign-in with wrong password
      const signInRes = await testHelper.graphQl({
        arguments: { input: { email, password: wrongPassword } },
        fields: ['token', { user: ['id'] }],
        name: 'signIn',
        type: TestGraphQLType.MUTATION,
      });

      expect(signInRes.errors).toBeDefined();
      expect(signInRes.errors[0].message).toContain('Wrong password');
    });
  });

  // ===================================================================================================================
  // 5. Email Change Sync
  // ===================================================================================================================

  describe('5. Email Change Sync', () => {
    it('should invalidate IAM sessions when email changes via direct DB update', async () => {
      if (!isBetterAuthEnabled) {
        console.debug('Better-Auth is not enabled, skipping test');
        return;
      }

      const oldEmail = generateTestEmail('email-change-legacy');
      const newEmail = generateTestEmail('email-changed-to');
      const password = 'EmailChange123!';

      // Sign up via Legacy
      await testHelper.graphQl({
        arguments: { input: { email: oldEmail, password } },
        fields: [{ user: ['id'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      // Sign in via IAM to create session and migration
      const iamSignIn = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email: oldEmail, password },
      });
      expect(iamSignIn.success).toBe(true);

      // Track for cleanup
      if (iamSignIn.user?.id) {
        testIamUserIds.push(iamSignIn.user.id);
      }

      // Verify session exists for the user
      const user = await iamDb.findUser({ email: oldEmail });
      expect(user).toBeDefined();
      const sessionBefore = await iamDb.findUserSession(user!.id);
      expect(sessionBefore).toBeDefined();

      // Update email directly via database (simulating Legacy service update)
      await iamDb.updateUser({ id: user!.id }, { email: newEmail });

      // Call the sync method directly (this is what CoreUserService.update would do)
      await userMapper?.syncEmailChangeFromLegacy(oldEmail, newEmail);

      // Verify email was updated in database
      const userByNewEmail = await iamDb.findUser({ email: newEmail });
      expect(userByNewEmail).toBeDefined();

      // Session should be invalidated after email change
      const sessionAfter = await iamDb.findUserSession(user!.id);
      expect(sessionAfter).toBeNull();

      // Add new email to cleanup
      testEmails.push(newEmail);
    });

    it('should allow sign-in with new email after email change', async () => {
      if (!isBetterAuthEnabled) {
        console.debug('Better-Auth is not enabled, skipping test');
        return;
      }

      const oldEmail = generateTestEmail('email-old');
      const newEmail = generateTestEmail('email-new');
      const password = 'EmailNewTest123!';

      // Sign up via IAM with old email
      const signUpRes = await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email: oldEmail, name: 'Email Test User', password, termsAndPrivacyAccepted: true },
        statusCode: 201,
      });
      expect(signUpRes.success).toBe(true);

      // Track for cleanup
      if (signUpRes.user?.id) {
        testIamUserIds.push(signUpRes.user.id);
      }

      // Find the user
      const user = await iamDb.findUser({ email: oldEmail });
      expect(user).toBeDefined();

      // Update email directly via database
      await iamDb.updateUser({ id: user!.id }, { email: newEmail });

      // Sign in via Legacy with new email
      const legacySignIn = await testHelper.graphQl({
        arguments: { input: { email: newEmail, password } },
        fields: ['token', { user: ['email'] }],
        name: 'signIn',
        type: TestGraphQLType.MUTATION,
      });
      expect(legacySignIn.user.email).toBe(newEmail);

      // Add new email to cleanup
      testEmails.push(newEmail);
    });
  });

  // ===================================================================================================================
  // 6. User Deletion Cleanup
  // ===================================================================================================================

  describe('6. User Deletion Cleanup', () => {
    it('should cleanup IAM data when user is deleted via direct mapper call', async () => {
      if (!isBetterAuthEnabled) {
        console.debug('Better-Auth is not enabled, skipping test');
        return;
      }

      const email = generateTestEmail('delete-cleanup');
      const password = 'DeleteTest123!';

      // Sign up via Legacy
      await testHelper.graphQl({
        arguments: { input: { email, password } },
        fields: [{ user: ['id'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      // Sign in via IAM to create session and account
      const iamSignIn = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password },
      });
      expect(iamSignIn.success).toBe(true);

      // Track for cleanup
      if (iamSignIn.user?.id) {
        testIamUserIds.push(iamSignIn.user.id);
      }

      // Verify IAM account exists
      const user = await iamDb.findUser({ email });
      expect(user).toBeDefined();
      const iamAccount = await iamDb.findAccount(user!.id);
      expect(iamAccount).toBeDefined();

      // Delete user from both systems using the mapper
      const deleteResult = await userMapper?.deleteUserFromBothSystems(email);
      expect(deleteResult?.success).toBe(true);
      expect(deleteResult?.userDeleted).toBe(true);

      // Verify user is deleted
      const deletedUser = await iamDb.findUser({ email });
      expect(deletedUser).toBeNull();

      // Verify IAM account and session are also deleted
      const deletedAccount = await iamDb.findAccount(user!.id);
      expect(deletedAccount).toBeNull();

      // Session should also be cleaned up
      const deletedSession = await iamDb.findUserSession(user!.id);
      expect(deletedSession).toBeNull();
    });

    it('should cleanup IAM data when cleanupIamDataForDeletedUser is called', async () => {
      if (!isBetterAuthEnabled) {
        console.debug('Better-Auth is not enabled, skipping test');
        return;
      }

      const email = generateTestEmail('cleanup-iam');
      const password = 'CleanupTest123!';

      // Sign up via Legacy
      await testHelper.graphQl({
        arguments: { input: { email, password } },
        fields: [{ user: ['id'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      // Sign in via IAM to create session and account
      const iamSignIn = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password },
      });
      expect(iamSignIn.success).toBe(true);

      // Track for cleanup
      if (iamSignIn.user?.id) {
        testIamUserIds.push(iamSignIn.user.id);
      }

      // Verify IAM account exists
      const user = await iamDb.findUser({ email });
      expect(user).toBeDefined();
      const iamAccount = await iamDb.findAccount(user!.id);
      expect(iamAccount).toBeDefined();
      const iamSession = await iamDb.findUserSession(user!.id);
      expect(iamSession).toBeDefined();

      // Cleanup IAM data (simulating what happens when Legacy deletes a user)
      const cleanupResult = await userMapper?.cleanupIamDataForDeletedUser(user!.id);
      expect(cleanupResult?.success).toBe(true);

      // User should still exist (only IAM data cleaned up)
      const userAfter = await iamDb.findUser({ email });
      expect(userAfter).toBeDefined();

      // IAM account and session should be deleted
      const deletedAccount = await iamDb.findAccount(user!.id);
      expect(deletedAccount).toBeNull();
      const deletedSession = await iamDb.findUserSession(user!.id);
      expect(deletedSession).toBeNull();
    });
  });
  // ===================================================================================================================
  // 7. Name Sync
  // ===================================================================================================================

  describe('7. Name Sync', () => {
    /**
     * @regression   found in 11.43.1 — CoreUserService.update() synced email and password changes to the
     *   Better-Auth side of the shared users document, but not firstName/lastName. The Better-Auth
     *   `name` therefore stayed stale, and the next IAM sign-in reverse-synced it back into
     *   firstName/lastName (linkOrCreateUser), silently discarding the user's edit.
     * @seen-failing Drop the `syncNameChangeFromLegacy()` call from CoreUserService.update() in
     *   src/core/modules/user/core-user.service.ts — registered as mutation
     *   `user-update-skips-iam-name-sync` in tests/regression-mutations.json.
     */
    it('should keep a firstName/lastName edit across the next IAM sign-in', async () => {
      if (!isBetterAuthEnabled) {
        console.debug('Better-Auth is not enabled, skipping test');
        return;
      }

      const email = generateTestEmail('name-edit');
      const password = 'NameEdit123!';

      const signUpRes = await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'Anna Maria', password, termsAndPrivacyAccepted: true },
        statusCode: 201,
      });
      expect(signUpRes.success).toBe(true);
      if (signUpRes.user?.id) {
        testIamUserIds.push(signUpRes.user.id);
      }

      const legacySignIn = await testHelper.graphQl({
        arguments: { input: { email, password } },
        fields: ['token', { user: ['id'] }],
        name: 'signIn',
        type: TestGraphQLType.MUTATION,
      });
      expect(legacySignIn.token).toBeDefined();

      // The user edits their own name (S_SELF) — a two-word first name and a two-word last name
      const updated = await testHelper.graphQl(
        {
          arguments: { id: legacySignIn.user.id, input: { firstName: 'Anna Maria', lastName: 'von Berg' } },
          fields: ['firstName', 'lastName'],
          name: 'updateUser',
          type: TestGraphQLType.MUTATION,
        },
        { token: legacySignIn.token },
      );
      expect(updated.firstName).toBe('Anna Maria');
      expect(updated.lastName).toBe('von Berg');

      // The Better-Auth name follows the edit
      const afterUpdate = await iamDb.findUser({ email });
      expect(afterUpdate!.name).toBe('Anna Maria von Berg');

      const iamSignIn = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password },
      });
      expect(iamSignIn.success).toBe(true);

      const afterSignIn = await iamDb.findUser({ email });
      expect(afterSignIn!.firstName).toBe('Anna Maria');
      expect(afterSignIn!.lastName).toBe('von Berg');
    });

    /**
     * @regression   found in 11.43.1 — linkOrCreateUser() re-split the Better-Auth `name` into
     *   firstName/lastName on EVERY sign-in. The split is lossy (first word vs. rest), so a stored
     *   "Anna Maria" / "von Berg" became "Anna" / "Maria von Berg" although nothing had changed on
     *   the Better-Auth side.
     * @seen-failing Make `nameChangedInIam` in linkOrCreateUser() always true in
     *   src/core/modules/better-auth/core-better-auth-user.mapper.ts — registered as mutation
     *   `iam-sign-in-resplits-unchanged-name` in tests/regression-mutations.json.
     */
    it('should not re-split an unchanged Better-Auth name on sign-in', async () => {
      if (!isBetterAuthEnabled) {
        console.debug('Better-Auth is not enabled, skipping test');
        return;
      }

      const email = generateTestEmail('name-unchanged');
      const password = 'NameKeep123!';

      const signUpRes = await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'Anna Maria von Berg', password, termsAndPrivacyAccepted: true },
        statusCode: 201,
      });
      expect(signUpRes.success).toBe(true);
      if (signUpRes.user?.id) {
        testIamUserIds.push(signUpRes.user.id);
      }

      // Locally maintained split that matches the Better-Auth name as a whole
      await iamDb.updateUser({ email }, { firstName: 'Anna Maria', lastName: 'von Berg' });

      const iamSignIn = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password },
      });
      expect(iamSignIn.success).toBe(true);

      const afterSignIn = await iamDb.findUser({ email });
      expect(afterSignIn!.firstName).toBe('Anna Maria');
      expect(afterSignIn!.lastName).toBe('von Berg');
    });

    it('should still reverse-sync a name that changed on the Better-Auth side', async () => {
      if (!isBetterAuthEnabled) {
        console.debug('Better-Auth is not enabled, skipping test');
        return;
      }

      const email = generateTestEmail('name-iam-change');
      const password = 'NameIam123!';

      const signUpRes = await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'Old Name', password, termsAndPrivacyAccepted: true },
        statusCode: 201,
      });
      expect(signUpRes.success).toBe(true);
      if (signUpRes.user?.id) {
        testIamUserIds.push(signUpRes.user.id);
      }

      // Name changed on the Better-Auth side only (e.g. via POST /iam/update-user)
      await iamDb.updateUser({ email }, { name: 'Jane Doe' });

      const iamSignIn = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password },
      });
      expect(iamSignIn.success).toBe(true);

      const afterSignIn = await iamDb.findUser({ email });
      expect(afterSignIn!.firstName).toBe('Jane');
      expect(afterSignIn!.lastName).toBe('Doe');
    });

    /**
     * @regression   found while integrating PR #647 (DEV-3821) — the first version of the name sync
     *   skipped an EMPTY result, so clearing both names left the old Better-Auth `name` in place,
     *   and the next IAM sign-in reverse-synced it into the fields the user had just cleared.
     * @seen-failing Restore the `fullName &&` skip in CoreUserService.update() in
     *   src/core/modules/user/core-user.service.ts — registered as mutation
     *   `user-update-skips-emptied-name-sync` in tests/regression-mutations.json.
     */
    it('should keep cleared names cleared across the next IAM sign-in', async () => {
      if (!isBetterAuthEnabled) {
        console.debug('Better-Auth is not enabled, skipping test');
        return;
      }

      const email = generateTestEmail('name-cleared');
      const password = 'NameClear123!';

      const signUpRes = await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'Anna Maria', password, termsAndPrivacyAccepted: true },
        statusCode: 201,
      });
      expect(signUpRes.success).toBe(true);
      if (signUpRes.user?.id) {
        testIamUserIds.push(signUpRes.user.id);
      }

      const legacySignIn = await testHelper.graphQl({
        arguments: { input: { email, password } },
        fields: ['token', { user: ['id'] }],
        name: 'signIn',
        type: TestGraphQLType.MUTATION,
      });
      expect(legacySignIn.token).toBeDefined();

      // The user clears both names (S_SELF)
      const updated = await testHelper.graphQl(
        {
          arguments: { id: legacySignIn.user.id, input: { firstName: '', lastName: '' } },
          fields: ['firstName', 'lastName'],
          name: 'updateUser',
          type: TestGraphQLType.MUTATION,
        },
        { token: legacySignIn.token },
      );
      expect(updated.firstName ?? '').toBe('');
      expect(updated.lastName ?? '').toBe('');

      // The Better-Auth name follows, also when it becomes empty
      const afterUpdate = await iamDb.findUser({ email });
      expect(afterUpdate!.name).toBe('');

      const iamSignIn = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password },
      });
      expect(iamSignIn.success).toBe(true);

      const afterSignIn = await iamDb.findUser({ email });
      expect(afterSignIn!.firstName ?? '').toBe('');
      expect(afterSignIn!.lastName ?? '').toBe('');
    });
  });
});
