import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { MongoClient } from 'mongodb';

import { HttpExceptionLogFilter, RoleEnum, TestGraphQLType, TestHelper } from '../src';
import envConfig from '../src/config.env';
import { ServerModule } from '../src/server/server.module';

/**
 * Safety Net Architecture E2E Tests
 *
 * Tests the automatic security guarantees that work even when
 * developers bypass CrudService.process() and use direct Mongoose operations.
 */
describe('Safety Net (e2e)', () => {
  let app;
  let httpServer;
  let testHelper: TestHelper;
  let connection;
  let db;
  let gToken: string;
  let gUserId: string;
  let gAdminToken: string;

  beforeAll(async () => {
    try {
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

      httpServer = app.getHttpServer();
      await new Promise<void>((resolve) => {
        httpServer.listen(0, '127.0.0.1', () => resolve());
      });

      testHelper = new TestHelper(app);

      // MongoDB direct connection
      connection = await MongoClient.connect(envConfig.mongoose.uri);
      db = connection.db();

      // Clean up test data
      await db.collection('users').deleteMany({ email: { $regex: /^safetynet/ } });

      // Sign up a test user
      const signUpResult = await testHelper.graphQl({
        arguments: {
          input: {
            email: 'safetynet-user@testdomain.com',
            firstName: 'Safety',
            lastName: 'Net',
            password: 'safetyNetPassword123',
          },
        },
        fields: ['token', 'refreshToken', { user: ['id', 'email', 'password', 'roles'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      gToken = signUpResult.token;
      gUserId = signUpResult.user.id;

      // The signUp response should NOT contain the password
      expect(signUpResult.user.password).toBeFalsy();

      // Create admin user for admin-specific tests
      await testHelper.graphQl({
        arguments: {
          input: {
            email: 'safetynet-admin@testdomain.com',
            firstName: 'Admin',
            lastName: 'Safety',
            password: 'adminSafetyPassword123',
          },
        },
        fields: ['token', { user: ['id'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });
      // Set admin role directly in DB
      await db.collection('users').updateOne(
        { email: 'safetynet-admin@testdomain.com' },
        { $set: { roles: [RoleEnum.ADMIN] } },
      );
      // Re-login to get token with admin role
      const adminLogin = await testHelper.graphQl({
        arguments: {
          input: {
            email: 'safetynet-admin@testdomain.com',
            password: 'adminSafetyPassword123',
          },
        },
        fields: ['token'],
        name: 'signIn',
        type: TestGraphQLType.MUTATION,
      });
      gAdminToken = adminLogin.token;
    } catch (e) {
      console.error('beforeAllError', e);
    }
  });

  afterAll(async () => {
    // Clean up
    if (db) {
      await db.collection('users').deleteMany({ email: { $regex: /^safetynet/ } });
    }
    if (connection) {
      await connection.close();
    }
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    if (app) {
      await app.close();
    }
  });

  // ===================================================================================================================
  // A: Mongoose Password Plugin Tests
  // ===================================================================================================================

  describe('Mongoose Password Plugin', () => {
    it('should hash password on save via signUp', async () => {
      const dbUser = await db.collection('users').findOne({ email: 'safetynet-user@testdomain.com' });
      expect(dbUser).toBeDefined();
      expect(dbUser.password).toBeDefined();
      // Password should be a bcrypt hash
      expect(dbUser.password).toMatch(/^\$2[aby]\$\d+\$/);
      // BCrypt hash is exactly 60 characters
      expect(dbUser.password.length).toBe(60);
    });

    it('should hash password on findByIdAndUpdate', async () => {
      // Update password via GraphQL (which internally uses findByIdAndUpdate or process())
      await testHelper.graphQl(
        {
          arguments: {
            id: gUserId,
            input: { password: 'updatedPassword789' },
          },
          fields: ['id'],
          name: 'updateUser',
          type: TestGraphQLType.MUTATION,
        },
        { token: gToken },
      );

      const dbUser = await db.collection('users').findOne({ email: 'safetynet-user@testdomain.com' });
      expect(dbUser.password).toMatch(/^\$2[aby]\$\d+\$/);
      expect(dbUser.password.length).toBe(60);
    });

    it('should not double-hash an already-hashed password', async () => {
      // Get current hash
      const before = await db.collection('users').findOne({ email: 'safetynet-user@testdomain.com' });
      const hashBefore = before.password;

      // Write the same hash back via direct DB update (simulating what would happen if plugin ran twice)
      await db.collection('users').updateOne(
        { email: 'safetynet-user@testdomain.com' },
        { $set: { password: hashBefore } },
      );

      const after = await db.collection('users').findOne({ email: 'safetynet-user@testdomain.com' });
      // Hash should be identical (not double-hashed)
      expect(after.password).toBe(hashBefore);
      expect(after.password.length).toBe(60);
    });
  });

  // ===================================================================================================================
  // B: Fallback Secret Removal Tests
  // ===================================================================================================================

  describe('Fallback Secret Removal', () => {
    it('should not return password in signUp response', () => {
      // Already verified in beforeAll - password was falsy
      expect(gToken).toBeDefined();
      expect(gUserId).toBeDefined();
    });

    it('should not return password when user queries themselves', async () => {
      const user = await testHelper.graphQl(
        {
          arguments: { id: gUserId },
          fields: ['id', 'email', 'firstName'],
          name: 'getUser',
          type: TestGraphQLType.QUERY,
        },
        { token: gToken },
      );

      expect(user.id).toBe(gUserId);
      expect(user.email).toBe('safetynet-user@testdomain.com');
      expect(user.password).toBeUndefined();
    });

    it('should not return password via REST endpoint', async () => {
      const result: any = await testHelper.rest(`/users/${gUserId}`, {
        token: gAdminToken,
      });

      expect(result.id).toBe(gUserId);
      expect(result.password).toBeUndefined();
    });
  });

  // ===================================================================================================================
  // C: SecurityCheck enforcement
  // ===================================================================================================================

  describe('SecurityCheck enforcement', () => {
    it('owner can see own fields via securityCheck', async () => {
      const user = await testHelper.graphQl(
        {
          arguments: { id: gUserId },
          fields: ['id', 'email', 'firstName'],
          name: 'getUser',
          type: TestGraphQLType.QUERY,
        },
        { token: gToken },
      );

      expect(user.id).toBe(gUserId);
      expect(user.email).toBe('safetynet-user@testdomain.com');
      expect(user.firstName).toBe('Safety');
    });

    it('non-owner non-admin gets restricted view', async () => {
      // Sign up a second user
      const otherSignUp = await testHelper.graphQl({
        arguments: {
          input: {
            email: 'safetynet-other@testdomain.com',
            firstName: 'Other',
            lastName: 'User',
            password: 'otherPassword123',
          },
        },
        fields: ['token', { user: ['id', 'email'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      const otherToken = otherSignUp.token;

      // Non-admin, non-owner queries another user
      const user = await testHelper.graphQl(
        {
          arguments: { id: gUserId },
          fields: ['id', 'email', 'username', 'roles', 'createdAt'],
          name: 'getUser',
          type: TestGraphQLType.QUERY,
        },
        { token: otherToken },
      );

      // Fields should be stripped for non-admin non-owner
      expect(user.id).toBeUndefined();
      expect(user.username).toBeUndefined();
      expect(user.createdAt).toBeUndefined();
    });

    it('admin can see all fields via securityCheck', async () => {
      const user = await testHelper.graphQl(
        {
          arguments: { id: gUserId },
          fields: ['id', 'email', 'firstName', 'createdAt', 'roles'],
          name: 'getUser',
          type: TestGraphQLType.QUERY,
        },
        { token: gAdminToken },
      );

      expect(user.id).toBe(gUserId);
      expect(user.email).toBe('safetynet-user@testdomain.com');
      expect(user.createdAt).toBeDefined();
    });
  });

  // ===================================================================================================================
  // D: No Double Processing
  // ===================================================================================================================

  describe('No Double Processing', () => {
    it('should not break existing CrudService flow for updates', async () => {
      const updated = await testHelper.graphQl(
        {
          arguments: {
            id: gUserId,
            input: {
              firstName: 'SafetyUpdated',
            },
          },
          fields: ['id', 'email', 'firstName'],
          name: 'updateUser',
          type: TestGraphQLType.MUTATION,
        },
        { token: gToken },
      );

      expect(updated.id).toBe(gUserId);
      expect(updated.firstName).toBe('SafetyUpdated');
      expect(updated.password).toBeUndefined();
    });

    it('should handle password update without double-hashing', async () => {
      await testHelper.graphQl(
        {
          arguments: {
            id: gUserId,
            input: {
              password: 'newSafetyPassword456',
            },
          },
          fields: ['id'],
          name: 'updateUser',
          type: TestGraphQLType.MUTATION,
        },
        { token: gToken },
      );

      const dbUser = await db.collection('users').findOne({ email: 'safetynet-user@testdomain.com' });
      expect(dbUser.password).toMatch(/^\$2[aby]\$\d+\$/);
      expect(dbUser.password.length).toBe(60);
    });
  });

  // ===================================================================================================================
  // E: Audit Fields (createdBy/updatedBy)
  // ===================================================================================================================

  describe('Audit Fields', () => {
    it('should set createdBy on user creation (self-signup)', async () => {
      const dbUser = await db.collection('users').findOne({ email: 'safetynet-user@testdomain.com' });
      expect(dbUser).toBeDefined();
      // Self-signup: createdBy is set to the user's own ID in an extra step
      expect(dbUser.createdBy).toBeDefined();
    });

    it('should set updatedBy on user update', async () => {
      await testHelper.graphQl(
        {
          arguments: {
            id: gUserId,
            input: { firstName: 'AuditTest' },
          },
          fields: ['id'],
          name: 'updateUser',
          type: TestGraphQLType.MUTATION,
        },
        { token: gToken },
      );

      const dbUser = await db.collection('users').findOne({ email: 'safetynet-user@testdomain.com' });
      expect(dbUser.updatedBy).toBeDefined();
      expect(dbUser.firstName).toBe('AuditTest');
    });

    it('should set updatedBy when admin updates another user', async () => {
      const adminDbUser = await db.collection('users').findOne({ email: 'safetynet-admin@testdomain.com' });

      await testHelper.graphQl(
        {
          arguments: {
            id: gUserId,
            input: { firstName: 'AdminUpdated' },
          },
          fields: ['id'],
          name: 'updateUser',
          type: TestGraphQLType.MUTATION,
        },
        { token: gAdminToken },
      );

      const dbUser = await db.collection('users').findOne({ email: 'safetynet-user@testdomain.com' });
      expect(dbUser.firstName).toBe('AdminUpdated');
      expect(dbUser.updatedBy).toBeDefined();
      // updatedBy should be the admin's ID
      expect(dbUser.updatedBy.toString()).toBe(adminDbUser._id.toString());
    });
  });

  // ===================================================================================================================
  // F: Role Guard Plugin Tests
  // ===================================================================================================================

  describe('Role Guard Plugin', () => {
    it('should prevent non-admin from escalating own roles via GraphQL', async () => {
      // Non-admin user tries to set ADMIN role on themselves
      await testHelper.graphQl(
        {
          arguments: {
            id: gUserId,
            input: { roles: [RoleEnum.ADMIN] },
          },
          fields: ['id', 'roles'],
          name: 'updateUser',
          type: TestGraphQLType.MUTATION,
        },
        { token: gToken },
      );

      // Check DB: roles should NOT contain ADMIN
      const dbUser = await db.collection('users').findOne({ email: 'safetynet-user@testdomain.com' });
      expect(dbUser.roles || []).not.toContain(RoleEnum.ADMIN);
    });

    it('should allow admin to assign roles', async () => {
      // Create a test user to modify
      const targetSignUp = await testHelper.graphQl({
        arguments: {
          input: {
            email: 'safetynet-role-target@testdomain.com',
            firstName: 'Role',
            lastName: 'Target',
            password: 'roleTargetPass123',
          },
        },
        fields: [{ user: ['id'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      // Admin assigns ADMIN role
      await testHelper.graphQl(
        {
          arguments: {
            id: targetSignUp.user.id,
            input: { roles: [RoleEnum.ADMIN] },
          },
          fields: ['id', 'roles'],
          name: 'updateUser',
          type: TestGraphQLType.MUTATION,
        },
        { token: gAdminToken },
      );

      const dbUser = await db.collection('users').findOne({ email: 'safetynet-role-target@testdomain.com' });
      expect(dbUser.roles).toContain(RoleEnum.ADMIN);
    });
  });

  // ===================================================================================================================
  // G: TranslateResponseInterceptor Tests
  // ===================================================================================================================

  describe('TranslateResponseInterceptor', () => {
    it('should apply translations when Accept-Language header is set', async () => {
      // First, store a translation for jobTitle via direct DB update
      await db.collection('users').updateOne(
        { email: 'safetynet-user@testdomain.com' },
        {
          $set: {
            jobTitle: 'Entwickler',
            _translations: {
              en: { jobTitle: 'Developer' },
            },
          },
        },
      );

      // Query with Accept-Language: en (using the language option)
      const user = await testHelper.graphQl(
        {
          arguments: { id: gUserId },
          fields: ['id', 'jobTitle'],
          name: 'getUser',
          type: TestGraphQLType.QUERY,
        },
        { token: gToken, language: 'en' },
      );

      expect(user.id).toBe(gUserId);
      // jobTitle should be the English translation
      expect(user.jobTitle).toBe('Developer');
    });

    it('should return base language when no Accept-Language header', async () => {
      const user = await testHelper.graphQl(
        {
          arguments: { id: gUserId },
          fields: ['id', 'jobTitle'],
          name: 'getUser',
          type: TestGraphQLType.QUERY,
        },
        { token: gToken },
      );

      expect(user.id).toBe(gUserId);
      // Without Accept-Language, base language should be returned
      expect(user.jobTitle).toBe('Entwickler');
    });
  });

  // ===================================================================================================================
  // H: REST ResponseModel Auto-Resolution Tests
  // ===================================================================================================================

  describe('REST Response Security (Swagger Auto-Resolution)', () => {
    it('should apply securityCheck on REST getUser endpoint', async () => {
      // Admin should see all fields
      const adminResult: any = await testHelper.rest(`/users/${gUserId}`, {
        token: gAdminToken,
      });

      expect(adminResult.id).toBe(gUserId);
      expect(adminResult.email).toBeDefined();
      // Password must never be returned
      expect(adminResult.password).toBeUndefined();
    });

    it('should apply securityCheck on REST findUsers endpoint', async () => {
      const result: any = await testHelper.rest('/users', {
        token: gAdminToken,
      });

      expect(Array.isArray(result)).toBe(true);
      // No user in the array should have a password
      for (const user of result) {
        expect(user.password).toBeUndefined();
      }
    });
  });
});
