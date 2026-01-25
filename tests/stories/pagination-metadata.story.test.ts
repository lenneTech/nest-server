/**
 * Story: Pagination Metadata for API Navigation
 *
 * As an API user,
 * I want to receive pagination metadata with paginated queries,
 * So that I can easily implement pagination UI components without calculating values myself.
 *
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { MongoClient, ObjectId } from 'mongodb';

import { HttpExceptionLogFilter, TestGraphQLType, TestHelper } from '../../src';
import envConfig from '../../src/config.env';
import { ServerModule } from '../../src/server/server.module';

describe('Story: Pagination Metadata', () => {
  // Test environment properties
  let app;
  let testHelper: TestHelper;

  // Database
  let mongoClient: MongoClient;
  let db;

  // Test data tracking
  const testUserIds: string[] = [];
  let adminToken: string;
  let adminUserId: string;

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

      mongoClient = await MongoClient.connect(envConfig.mongoose.uri);
      db = mongoClient.db();

      // Create admin user for testing
      const adminEmail = `pagination-admin-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
      const adminPassword = 'TestPassword123!';

      const signUpResult: any = await testHelper.graphQl({
        arguments: {
          input: { email: adminEmail, password: adminPassword },
        },
        fields: ['token', { user: ['id'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      adminUserId = signUpResult.user.id;
      testUserIds.push(adminUserId);

      // Make user admin and verified
      await db.collection('users').updateOne(
        { _id: new ObjectId(adminUserId) },
        { $set: { roles: ['admin'], verified: true } },
      );

      // Sign in to get fresh token with admin role
      const signInResult: any = await testHelper.graphQl({
        arguments: {
          input: { email: adminEmail, password: adminPassword },
        },
        fields: ['token'],
        name: 'signIn',
        type: TestGraphQLType.MUTATION,
      });
      adminToken = signInResult.token;
    } catch (e) {
      console.error('beforeAllError', e);
      throw e;
    }
  });

  afterAll(async () => {
    // Cleanup test users
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

  // ===================================================================================================================
  // Helper Functions
  // ===================================================================================================================

  function generateTestEmail(): string {
    return `pagination-test-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
  }

  async function createTestUser(email?: string): Promise<string> {
    const testEmail = email || generateTestEmail();
    const res: any = await testHelper.graphQl({
      arguments: {
        input: { email: testEmail, password: 'TestPassword123!' },
      },
      fields: ['token', { user: ['id'] }],
      name: 'signUp',
      type: TestGraphQLType.MUTATION,
    });
    testUserIds.push(res.user.id);
    return res.user.id;
  }

  // ===================================================================================================================
  // Tests: Pagination Object in Response
  // ===================================================================================================================

  describe('Pagination Object Structure', () => {
    it('should return pagination object with all required fields', async () => {
      const result: any = await testHelper.graphQl(
        {
          arguments: {
            skip: 0,
            take: 10,
          },
          fields: [
            'totalCount',
            { items: ['id', 'email'] },
            {
              pagination: [
                'totalCount',
                'pageCount',
                'currentPage',
                'perPage',
                'hasNextPage',
                'hasPreviousPage',
              ],
            },
          ],
          name: 'findAndCountUsers',
          type: TestGraphQLType.QUERY,
        },
        { token: adminToken },
      );

      expect(result).toBeDefined();
      expect(result.pagination).toBeDefined();
      expect(result.pagination.totalCount).toBeGreaterThanOrEqual(1);
      expect(result.pagination.pageCount).toBeGreaterThanOrEqual(1);
      expect(result.pagination.currentPage).toBe(1);
      expect(result.pagination.perPage).toBe(10);
      expect(typeof result.pagination.hasNextPage).toBe('boolean');
      expect(typeof result.pagination.hasPreviousPage).toBe('boolean');
    });

    it('should calculate pageCount correctly', async () => {
      // Create additional test users to ensure we have multiple pages
      const usersToCreate = 5;
      for (let i = 0; i < usersToCreate; i++) {
        await createTestUser();
      }

      const result: any = await testHelper.graphQl(
        {
          arguments: {
            skip: 0,
            take: 2, // Small page size to ensure multiple pages
          },
          fields: [
            'totalCount',
            { items: ['id'] },
            { pagination: ['totalCount', 'pageCount', 'perPage'] },
          ],
          name: 'findAndCountUsers',
          type: TestGraphQLType.QUERY,
        },
        { token: adminToken },
      );

      // pageCount should be Math.ceil(totalCount / perPage)
      const expectedPageCount = Math.ceil(result.pagination.totalCount / result.pagination.perPage);
      expect(result.pagination.pageCount).toBe(expectedPageCount);
    });
  });

  // ===================================================================================================================
  // Tests: hasNextPage and hasPreviousPage
  // ===================================================================================================================

  describe('Navigation Flags', () => {
    it('should return hasPreviousPage = false on first page', async () => {
      const result: any = await testHelper.graphQl(
        {
          arguments: {
            skip: 0,
            take: 10,
          },
          fields: [{ pagination: ['currentPage', 'hasPreviousPage'] }],
          name: 'findAndCountUsers',
          type: TestGraphQLType.QUERY,
        },
        { token: adminToken },
      );

      expect(result.pagination.currentPage).toBe(1);
      expect(result.pagination.hasPreviousPage).toBe(false);
    });

    it('should return hasNextPage = true when more items exist', async () => {
      // Ensure we have enough users for multiple pages
      const totalUsersResult: any = await testHelper.graphQl(
        {
          fields: ['totalCount'],
          name: 'findAndCountUsers',
          type: TestGraphQLType.QUERY,
        },
        { token: adminToken },
      );

      // Only run this test if we have more than 1 user
      if (totalUsersResult.totalCount > 1) {
        const result: any = await testHelper.graphQl(
          {
            arguments: {
              skip: 0,
              take: 1, // Only take 1 item
            },
            fields: [
              'totalCount',
              { pagination: ['hasNextPage', 'totalCount', 'perPage'] },
            ],
            name: 'findAndCountUsers',
            type: TestGraphQLType.QUERY,
          },
          { token: adminToken },
        );

        expect(result.pagination.hasNextPage).toBe(true);
      }
    });

    it('should return hasNextPage = false on last page', async () => {
      // Get total count first
      const countResult: any = await testHelper.graphQl(
        {
          fields: ['totalCount'],
          name: 'findAndCountUsers',
          type: TestGraphQLType.QUERY,
        },
        { token: adminToken },
      );

      const totalCount = countResult.totalCount;

      // Query for all items (high take value)
      const result: any = await testHelper.graphQl(
        {
          arguments: {
            skip: 0,
            take: totalCount + 10, // Take more than total to be on last page
          },
          fields: [{ pagination: ['hasNextPage', 'currentPage', 'pageCount'] }],
          name: 'findAndCountUsers',
          type: TestGraphQLType.QUERY,
        },
        { token: adminToken },
      );

      expect(result.pagination.hasNextPage).toBe(false);
    });

    it('should return hasPreviousPage = true on second page', async () => {
      // Ensure we have enough users
      const countResult: any = await testHelper.graphQl(
        {
          fields: ['totalCount'],
          name: 'findAndCountUsers',
          type: TestGraphQLType.QUERY,
        },
        { token: adminToken },
      );

      // Only run this test if we have more than 2 users
      if (countResult.totalCount > 2) {
        const result: any = await testHelper.graphQl(
          {
            arguments: {
              skip: 2, // Skip first page
              take: 2,
            },
            fields: [{ pagination: ['currentPage', 'hasPreviousPage'] }],
            name: 'findAndCountUsers',
            type: TestGraphQLType.QUERY,
          },
          { token: adminToken },
        );

        expect(result.pagination.currentPage).toBe(2);
        expect(result.pagination.hasPreviousPage).toBe(true);
      }
    });
  });

  // ===================================================================================================================
  // Tests: Edge Cases
  // ===================================================================================================================

  describe('Edge Cases', () => {
    it('should handle empty results with sensible defaults', async () => {
      // Query with filter that returns no results
      const result: any = await testHelper.graphQl(
        {
          arguments: {
            filter: {
              singleFilter: {
                field: 'email',
                operator: 'EQ',
                value: 'nonexistent-user-that-does-not-exist@test.com',
              },
            },
            skip: 0,
            take: 10,
          },
          fields: [
            'totalCount',
            { items: ['id'] },
            {
              pagination: [
                'totalCount',
                'pageCount',
                'currentPage',
                'perPage',
                'hasNextPage',
                'hasPreviousPage',
              ],
            },
          ],
          name: 'findAndCountUsers',
          type: TestGraphQLType.QUERY,
        },
        { token: adminToken },
      );

      expect(result.totalCount).toBe(0);
      expect(result.items).toHaveLength(0);
      expect(result.pagination.totalCount).toBe(0);
      expect(result.pagination.pageCount).toBe(0);
      expect(result.pagination.currentPage).toBe(0);
      expect(result.pagination.perPage).toBe(10);
      expect(result.pagination.hasNextPage).toBe(false);
      expect(result.pagination.hasPreviousPage).toBe(false);
    });

    it('should use default perPage when no take/limit is specified', async () => {
      const result: any = await testHelper.graphQl(
        {
          fields: [{ pagination: ['perPage'] }],
          name: 'findAndCountUsers',
          type: TestGraphQLType.QUERY,
        },
        { token: adminToken },
      );

      // perPage should have a sensible default (in this implementation, 0 when no limit specified)
      expect(result.pagination.perPage).toBeDefined();
    });
  });

  // ===================================================================================================================
  // Tests: Backward Compatibility
  // ===================================================================================================================

  describe('Backward Compatibility', () => {
    it('should still work without requesting pagination field', async () => {
      const result: any = await testHelper.graphQl(
        {
          arguments: {
            skip: 0,
            take: 10,
          },
          fields: ['totalCount', { items: ['id', 'email'] }],
          name: 'findAndCountUsers',
          type: TestGraphQLType.QUERY,
        },
        { token: adminToken },
      );

      expect(result).toBeDefined();
      expect(result.totalCount).toBeGreaterThanOrEqual(1);
      expect(result.items).toBeDefined();
      expect(Array.isArray(result.items)).toBe(true);
    });

    it('should return items and totalCount at root level as before', async () => {
      const result: any = await testHelper.graphQl(
        {
          arguments: {
            take: 5,
          },
          fields: ['totalCount', { items: ['id'] }],
          name: 'findAndCountUsers',
          type: TestGraphQLType.QUERY,
        },
        { token: adminToken },
      );

      // Verify original structure is preserved
      expect(result.totalCount).toBeDefined();
      expect(typeof result.totalCount).toBe('number');
      expect(result.items).toBeDefined();
      expect(Array.isArray(result.items)).toBe(true);
    });
  });

  // ===================================================================================================================
  // Tests: Current Page Calculation
  // ===================================================================================================================

  describe('Current Page Calculation', () => {
    it('should calculate currentPage correctly from skip and take', async () => {
      const perPage = 3;

      // Page 1: skip 0
      const page1: any = await testHelper.graphQl(
        {
          arguments: {
            skip: 0,
            take: perPage,
          },
          fields: [{ pagination: ['currentPage'] }],
          name: 'findAndCountUsers',
          type: TestGraphQLType.QUERY,
        },
        { token: adminToken },
      );
      expect(page1.pagination.currentPage).toBe(1);

      // Page 2: skip 3
      const page2: any = await testHelper.graphQl(
        {
          arguments: {
            skip: perPage,
            take: perPage,
          },
          fields: [{ pagination: ['currentPage'] }],
          name: 'findAndCountUsers',
          type: TestGraphQLType.QUERY,
        },
        { token: adminToken },
      );
      expect(page2.pagination.currentPage).toBe(2);

      // Page 3: skip 6
      const page3: any = await testHelper.graphQl(
        {
          arguments: {
            skip: perPage * 2,
            take: perPage,
          },
          fields: [{ pagination: ['currentPage'] }],
          name: 'findAndCountUsers',
          type: TestGraphQLType.QUERY,
        },
        { token: adminToken },
      );
      expect(page3.pagination.currentPage).toBe(3);
    });
  });
});
