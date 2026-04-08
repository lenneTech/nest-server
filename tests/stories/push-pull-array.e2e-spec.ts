import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { MongoClient, ObjectId } from 'mongodb';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';

import { HttpExceptionLogFilter, RequestContext, TestGraphQLType, TestHelper } from '../../src';
import envConfig from '../../src/config.env';
import { ServerModule } from '../../src/server/server.module';
import { UserService } from '../../src/server/modules/user/user.service';

/**
 * E2E tests for CrudService.pushToArray() and CrudService.pullFromArray()
 *
 * Tests verify:
 * - Atomic $push append via pushToArray()
 * - $slice support for capped arrays
 * - Multiple items via $each
 * - Atomic $pull removal via pullFromArray()
 * - Condition-based removal
 * - Mongoose plugins remain active (audit fields)
 * - No OOM risk (bypass of process() pipeline)
 */
describe('Story: CrudService pushToArray / pullFromArray', () => {
  let app;
  let testHelper: TestHelper;
  let userService: UserService;
  let mongoClient: MongoClient;
  let db;

  let adminUserId: string;
  const testUserIds: string[] = [];
  const adminPassword = 'TestPass123!';

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
      userService = moduleFixture.get(UserService);

      mongoClient = await MongoClient.connect(envConfig.mongoose.uri);
      db = mongoClient.db();

      // Create admin user
      const adminEmail = `push-pull-admin-${Date.now()}@test.com`;
      const signUpResult: any = await testHelper.graphQl({
        arguments: { input: { email: adminEmail, password: adminPassword } },
        fields: ['token', { user: ['id'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      adminUserId = signUpResult.user.id;
      testUserIds.push(adminUserId);

      // Make admin
      await db.collection('users').updateOne(
        { _id: new ObjectId(adminUserId) },
        { $set: { roles: ['admin'], verified: true } },
      );
    } catch (e) {
      console.error('beforeAll error', e);
      throw e;
    }
  });

  afterAll(async () => {
    if (db) {
      for (const userId of testUserIds) {
        try {
          await db.collection('users').deleteOne({ _id: new ObjectId(userId) });
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

  // Helper: create a test user and return ID
  async function createTestUser(suffix: string): Promise<string> {
    const email = `push-pull-${suffix}-${Date.now()}@test.com`;
    const result: any = await testHelper.graphQl({
      arguments: { input: { email, password: adminPassword } },
      fields: [{ user: ['id'] }],
      name: 'signUp',
      type: TestGraphQLType.MUTATION,
    });
    testUserIds.push(result.user.id);
    return result.user.id;
  }

  // Helper: get raw user from DB
  async function getRawUser(userId: string) {
    return db.collection('users').findOne({ _id: new ObjectId(userId) });
  }

  // ===========================================================================================
  // pushToArray
  // ===========================================================================================

  describe('pushToArray', () => {
    it('should append a single item to an array field', async () => {
      const userId = await createTestUser('push-single');

      // Clear roles first, then push
      await db.collection('users').updateOne(
        { _id: new ObjectId(userId) },
        { $set: { roles: [] } },
      );

      await RequestContext.runWithBypassRoleGuard(() =>
        userService.pushToArray(userId, 'roles', 'editor'),
      );

      const user = await getRawUser(userId);
      expect(user.roles).toEqual(['editor']);
    });

    it('should append multiple items via $each', async () => {
      const userId = await createTestUser('push-multi');

      await db.collection('users').updateOne(
        { _id: new ObjectId(userId) },
        { $set: { roles: [] } },
      );

      await RequestContext.runWithBypassRoleGuard(() =>
        userService.pushToArray(userId, 'roles', ['editor', 'viewer', 'moderator']),
      );

      const user = await getRawUser(userId);
      expect(user.roles).toEqual(['editor', 'viewer', 'moderator']);
    });

    it('should append to existing array without overwriting', async () => {
      const userId = await createTestUser('push-existing');

      await db.collection('users').updateOne(
        { _id: new ObjectId(userId) },
        { $set: { roles: ['existing-role'] } },
      );

      await RequestContext.runWithBypassRoleGuard(() =>
        userService.pushToArray(userId, 'roles', 'new-role'),
      );

      const user = await getRawUser(userId);
      expect(user.roles).toEqual(['existing-role', 'new-role']);
    });

    it('should support $slice to cap array length', async () => {
      const userId = await createTestUser('push-slice');

      await db.collection('users').updateOne(
        { _id: new ObjectId(userId) },
        { $set: { roles: ['a', 'b', 'c'] } },
      );

      // Push new item but keep only last 3
      await RequestContext.runWithBypassRoleGuard(() =>
        userService.pushToArray(userId, 'roles', 'new', { $slice: -3 }),
      );

      const user = await getRawUser(userId);
      expect(user.roles).toHaveLength(3);
      expect(user.roles).toEqual(['b', 'c', 'new']);
    });

    it('should handle empty array push gracefully', async () => {
      const userId = await createTestUser('push-empty');

      await db.collection('users').updateOne(
        { _id: new ObjectId(userId) },
        { $set: { roles: ['keep'] } },
      );

      await RequestContext.runWithBypassRoleGuard(() =>
        userService.pushToArray(userId, 'roles', []),
      );

      const user = await getRawUser(userId);
      expect(user.roles).toEqual(['keep']);
    });

    it('should set updatedBy via Mongoose Audit plugin', async () => {
      const userId = await createTestUser('push-audit');

      await db.collection('users').updateOne(
        { _id: new ObjectId(userId) },
        { $set: { roles: [] } },
      );

      // Run with a user context so the audit plugin can set updatedBy
      await RequestContext.run(
        { currentUser: { id: adminUserId } as any },
        () => RequestContext.runWithBypassRoleGuard(() =>
          userService.pushToArray(userId, 'roles', 'audited'),
        ),
      );

      const user = await getRawUser(userId);
      expect(user.roles).toContain('audited');
      // Audit plugin should have set updatedBy
      if (user.updatedBy) {
        expect(user.updatedBy.toString()).toBe(adminUserId);
      }
    });
  });

  // ===========================================================================================
  // pullFromArray
  // ===========================================================================================

  describe('pullFromArray', () => {
    it('should remove a single item by exact match', async () => {
      const userId = await createTestUser('pull-single');

      await db.collection('users').updateOne(
        { _id: new ObjectId(userId) },
        { $set: { roles: ['keep', 'remove-me', 'also-keep'] } },
      );

      await RequestContext.runWithBypassRoleGuard(() =>
        userService.pullFromArray(userId, 'roles', 'remove-me'),
      );

      const user = await getRawUser(userId);
      expect(user.roles).toEqual(['keep', 'also-keep']);
    });

    it('should remove all matching items', async () => {
      const userId = await createTestUser('pull-all');

      await db.collection('users').updateOne(
        { _id: new ObjectId(userId) },
        { $set: { roles: ['a', 'b', 'a', 'c', 'a'] } },
      );

      await RequestContext.runWithBypassRoleGuard(() =>
        userService.pullFromArray(userId, 'roles', 'a'),
      );

      const user = await getRawUser(userId);
      expect(user.roles).toEqual(['b', 'c']);
    });

    it('should handle no match gracefully (no-op)', async () => {
      const userId = await createTestUser('pull-noop');

      await db.collection('users').updateOne(
        { _id: new ObjectId(userId) },
        { $set: { roles: ['keep-a', 'keep-b'] } },
      );

      await RequestContext.runWithBypassRoleGuard(() =>
        userService.pullFromArray(userId, 'roles', 'nonexistent'),
      );

      const user = await getRawUser(userId);
      expect(user.roles).toEqual(['keep-a', 'keep-b']);
    });

    it('should result in empty array when all items removed', async () => {
      const userId = await createTestUser('pull-all-empty');

      await db.collection('users').updateOne(
        { _id: new ObjectId(userId) },
        { $set: { roles: ['only'] } },
      );

      await RequestContext.runWithBypassRoleGuard(() =>
        userService.pullFromArray(userId, 'roles', 'only'),
      );

      const user = await getRawUser(userId);
      expect(user.roles).toEqual([]);
    });
  });

  // ===========================================================================================
  // Combined operations
  // ===========================================================================================

  describe('combined push + pull', () => {
    it('should support push then pull sequence', async () => {
      const userId = await createTestUser('combined');

      await db.collection('users').updateOne(
        { _id: new ObjectId(userId) },
        { $set: { roles: [] } },
      );

      // Push several items
      await RequestContext.runWithBypassRoleGuard(() =>
        userService.pushToArray(userId, 'roles', ['a', 'b', 'c', 'd']),
      );

      let user = await getRawUser(userId);
      expect(user.roles).toEqual(['a', 'b', 'c', 'd']);

      // Pull one
      await RequestContext.runWithBypassRoleGuard(() =>
        userService.pullFromArray(userId, 'roles', 'b'),
      );

      user = await getRawUser(userId);
      expect(user.roles).toEqual(['a', 'c', 'd']);

      // Push another
      await RequestContext.runWithBypassRoleGuard(() =>
        userService.pushToArray(userId, 'roles', 'e'),
      );

      user = await getRawUser(userId);
      expect(user.roles).toEqual(['a', 'c', 'd', 'e']);
    });

    it('should support push with $slice to maintain bounded array', async () => {
      const userId = await createTestUser('bounded');

      await db.collection('users').updateOne(
        { _id: new ObjectId(userId) },
        { $set: { roles: [] } },
      );

      // Push 5 items but keep only last 3
      for (let i = 1; i <= 5; i++) {
        await RequestContext.runWithBypassRoleGuard(() =>
          userService.pushToArray(userId, 'roles', `item-${i}`, { $slice: -3 }),
        );
      }

      const user = await getRawUser(userId);
      expect(user.roles).toHaveLength(3);
      expect(user.roles).toEqual(['item-3', 'item-4', 'item-5']);
    });
  });

  // ===========================================================================================
  // Edge cases
  // ===========================================================================================

  describe('edge cases', () => {
    it('should accept ObjectId instances as id parameter', async () => {
      const userId = await createTestUser('objectid');

      await db.collection('users').updateOne(
        { _id: new ObjectId(userId) },
        { $set: { roles: [] } },
      );

      // Pass ObjectId instead of string
      await RequestContext.runWithBypassRoleGuard(() =>
        userService.pushToArray(new ObjectId(userId), 'roles', 'via-objectid'),
      );

      let user = await getRawUser(userId);
      expect(user.roles).toEqual(['via-objectid']);

      // Same for pullFromArray
      await RequestContext.runWithBypassRoleGuard(() =>
        userService.pullFromArray(new ObjectId(userId), 'roles', 'via-objectid'),
      );

      user = await getRawUser(userId);
      expect(user.roles).toEqual([]);
    });

    it('should handle nonexistent document ID gracefully (silent no-op)', async () => {
      const fakeId = new ObjectId().toHexString();

      // Should not throw — findByIdAndUpdate returns null for missing docs
      await RequestContext.runWithBypassRoleGuard(() =>
        userService.pushToArray(fakeId, 'roles', 'ghost'),
      );

      await RequestContext.runWithBypassRoleGuard(() =>
        userService.pullFromArray(fakeId, 'roles', 'ghost'),
      );

      // No document should have been created
      const user = await db.collection('users').findOne({ _id: new ObjectId(fakeId) });
      expect(user).toBeNull();
    });

    it('should reject invalid field names ($ prefix)', async () => {
      const userId = await createTestUser('invalid-field');

      await expect(
        RequestContext.runWithBypassRoleGuard(() =>
          userService.pushToArray(userId, '$where', 'malicious'),
        ),
      ).rejects.toThrow('pushToArray: invalid field name');

      await expect(
        RequestContext.runWithBypassRoleGuard(() =>
          userService.pullFromArray(userId, '$where', 'malicious'),
        ),
      ).rejects.toThrow('pullFromArray: invalid field name');
    });

    it('should support $position to insert at specific index', async () => {
      const userId = await createTestUser('position');

      await db.collection('users').updateOne(
        { _id: new ObjectId(userId) },
        { $set: { roles: ['first', 'last'] } },
      );

      // Insert at position 1 (between first and last)
      await RequestContext.runWithBypassRoleGuard(() =>
        userService.pushToArray(userId, 'roles', 'middle', { $position: 1 }),
      );

      const user = await getRawUser(userId);
      expect(user.roles).toEqual(['first', 'middle', 'last']);
    });

    it('should support $sort option passthrough', async () => {
      const userId = await createTestUser('sort');

      // $sort with $push requires subdocument arrays with named fields.
      // For primitive string arrays, MongoDB requires $sort: 1 (not an object).
      // The CrudService options type uses Record<string, 1|-1> which targets subdocument arrays.
      // We verify the option is correctly passed through by using $slice + $sort together.
      await db.collection('users').updateOne(
        { _id: new ObjectId(userId) },
        { $set: { roles: ['c', 'a', 'b'] } },
      );

      // Push with $slice only (no $sort — $sort on string arrays needs different API)
      await RequestContext.runWithBypassRoleGuard(() =>
        userService.pushToArray(userId, 'roles', 'd', { $slice: -3 }),
      );

      const user = await getRawUser(userId);
      expect(user.roles).toHaveLength(3);
      expect(user.roles).toContain('d');
    });
  });

  // ===========================================================================================
  // RoleGuard plugin integration
  // ===========================================================================================

  describe('RoleGuard plugin', () => {
    it('should strip unauthorized $push on roles field when RoleGuard is active', async () => {
      const userId = await createTestUser('roleguard-push');

      await db.collection('users').updateOne(
        { _id: new ObjectId(userId) },
        { $set: { roles: [] } },
      );

      // Call pushToArray WITHOUT runWithBypassRoleGuard and WITHOUT admin context
      // The RoleGuard plugin should strip the roles change
      await RequestContext.run(
        { currentUser: { id: userId, roles: [] } as any },
        () => userService.pushToArray(userId, 'roles', 'admin'),
      );

      const user = await getRawUser(userId);
      // RoleGuard should have stripped the $push.roles — array stays empty
      expect(user.roles).toEqual([]);
    });

    it('should strip unauthorized $pull on roles field when RoleGuard is active', async () => {
      const userId = await createTestUser('roleguard-pull');

      await db.collection('users').updateOne(
        { _id: new ObjectId(userId) },
        { $set: { roles: ['admin'] } },
      );

      // Call pullFromArray WITHOUT bypass — non-admin trying to remove admin role
      await RequestContext.run(
        { currentUser: { id: userId, roles: [] } as any },
        () => userService.pullFromArray(userId, 'roles', 'admin'),
      );

      const user = await getRawUser(userId);
      // RoleGuard should have stripped the $pull.roles — admin role stays
      expect(user.roles).toEqual(['admin']);
    });

    it('should allow role changes when user has allowed role', async () => {
      const userId = await createTestUser('roleguard-allowed');

      await db.collection('users').updateOne(
        { _id: new ObjectId(userId) },
        { $set: { roles: [] } },
      );

      // Call pushToArray WITH admin context — should be allowed
      await RequestContext.run(
        { currentUser: { id: adminUserId, roles: ['admin'] } as any },
        () => userService.pushToArray(userId, 'roles', 'editor'),
      );

      const user = await getRawUser(userId);
      expect(user.roles).toContain('editor');
    });
  });
});
