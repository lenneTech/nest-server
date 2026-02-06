/**
 * Story: System Setup - Initial Admin Creation
 *
 * As a developer deploying a fresh system,
 * I want to create an initial admin user via REST API,
 * So that I can access the system even when signup is disabled.
 *
 * Test scenarios:
 * - Status returns needsSetup: true when zero users
 * - Init creates admin user successfully
 * - Created admin has admin role
 * - Created admin can sign in via BetterAuth
 * - Status returns needsSetup: false after init
 * - Init returns 403 when users already exist
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { MongoClient } from 'mongodb';

import { CoreBetterAuthService, HttpExceptionLogFilter, TestHelper } from '../../src';
import envConfig from '../../src/config.env';
import { ServerModule } from '../../src/server/server.module';

describe('Story: System Setup', () => {
  let app;
  let testHelper: TestHelper;
  let betterAuthService: CoreBetterAuthService;

  // Database
  let mongoClient: MongoClient;
  let db;

  // Track created test data for cleanup
  const testEmails: string[] = [];

  const SETUP_ADMIN_EMAIL = `setup-admin-${Date.now()}@test.com`;
  const SETUP_ADMIN_PASSWORD = 'TestPassword123!';
  const SETUP_ADMIN_NAME = 'Setup Admin';

  // ===================================================================================================================
  // Setup & Teardown
  // ===================================================================================================================

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

      testHelper = new TestHelper(app);
      betterAuthService = moduleFixture.get(CoreBetterAuthService);

      mongoClient = await MongoClient.connect(envConfig.mongoose.uri);
      db = mongoClient.db();
    } catch (e) {
      console.error('beforeAll Error', e);
      throw e;
    }
  });

  afterAll(async () => {
    // Cleanup all test users and associated IAM data
    if (db) {
      for (const email of testEmails) {
        try {
          const user = await db.collection('users').findOne({ email });
          if (user) {
            await db.collection('users').deleteOne({ _id: user._id });
            if (user.iamId) {
              await db.collection('account').deleteMany({ userId: user.iamId });
              await db.collection('session').deleteMany({ userId: user.iamId });
            }
          }
        } catch {
          // Ignore cleanup errors
        }
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
  // Helper: Clear all users to simulate fresh system
  // ===================================================================================================================

  async function clearAllUsers() {
    // BetterAuth shares the 'users' collection (modelName: 'users')
    await db.collection('users').deleteMany({});
    await db.collection('account').deleteMany({});
    await db.collection('session').deleteMany({});
  }

  // ===================================================================================================================
  // Tests
  // ===================================================================================================================

  describe('GET /api/system-setup/status', () => {
    it('should return needsSetup: true when zero users exist', async () => {
      // Clear all users to simulate fresh deployment
      await clearAllUsers();

      const result = await testHelper.rest('/api/system-setup/status', {
        method: 'GET',
        statusCode: 200,
      });

      expect(result).toBeDefined();
      expect(result.needsSetup).toBe(true);
      expect(result.betterAuthEnabled).toBe(betterAuthService.isEnabled());
    });

    it('should return needsSetup: false when users exist', async () => {
      // Ensure at least one user exists
      await db.collection('users').insertOne({
        createdAt: new Date(),
        email: 'existing@test.com',
        roles: [],
      });
      testEmails.push('existing@test.com');

      const result = await testHelper.rest('/api/system-setup/status', {
        method: 'GET',
        statusCode: 200,
      });

      expect(result).toBeDefined();
      expect(result.needsSetup).toBe(false);

      // Cleanup the test user
      await db.collection('users').deleteOne({ email: 'existing@test.com' });
      testEmails.pop();
    });
  });

  describe('POST /api/system-setup/init', () => {
    it('should create initial admin successfully when zero users exist', async () => {
      // Clear all users to simulate fresh deployment
      await clearAllUsers();
      testEmails.push(SETUP_ADMIN_EMAIL);

      const result = await testHelper.rest('/api/system-setup/init', {
        method: 'POST',
        payload: {
          email: SETUP_ADMIN_EMAIL,
          name: SETUP_ADMIN_NAME,
          password: SETUP_ADMIN_PASSWORD,
        },
        statusCode: 201,
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.email).toBe(SETUP_ADMIN_EMAIL);
    });

    it('should have created user with admin role', async () => {
      const user = await db.collection('users').findOne({ email: SETUP_ADMIN_EMAIL });

      expect(user).toBeDefined();
      expect(user.roles).toContain('admin');
      expect(user.iamId).toBeDefined();
    });

    it('should have created BetterAuth user and account', async () => {
      const user = await db.collection('users').findOne({ email: SETUP_ADMIN_EMAIL });
      expect(user).toBeDefined();
      expect(user.iamId).toBeDefined();

      // BetterAuth shares the 'users' collection (modelName: 'users')
      // The account collection links via userId (can be ObjectId or string)
      // Query by both _id and iamId to handle either format
      const account = await db.collection('account').findOne({
        $or: [{ userId: user._id }, { userId: user.iamId }],
        providerId: 'credential',
      });
      expect(account).toBeDefined();
      expect(account.password).toBeDefined();
    });

    it('should allow the created admin to sign in via BetterAuth', async () => {
      if (!betterAuthService.isEnabled()) {
        return;
      }

      // Sign in via BetterAuth REST endpoint
      const signInResult = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: {
          email: SETUP_ADMIN_EMAIL,
          password: SETUP_ADMIN_PASSWORD,
        },
        statusCode: 200,
      });

      expect(signInResult).toBeDefined();
      expect(signInResult.token || signInResult.user).toBeDefined();
    });

    it('should return needsSetup: false after init', async () => {
      const result = await testHelper.rest('/api/system-setup/status', {
        method: 'GET',
        statusCode: 200,
      });

      expect(result).toBeDefined();
      expect(result.needsSetup).toBe(false);
    });

    it('should return 403 when users already exist', async () => {
      const result = await testHelper.rest('/api/system-setup/init', {
        method: 'POST',
        payload: {
          email: `setup-second-${Date.now()}@test.com`,
          password: 'AnotherPassword123!',
        },
        statusCode: 403,
      });

      expect(result).toBeDefined();
      expect(result.message).toContain('LTNS_0050');
    });
  });
});
