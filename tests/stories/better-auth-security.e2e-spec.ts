/**
 * Story: BetterAuth Security Integration
 *
 * As a developer using @lenne.tech/nest-server,
 * I want Better-Auth users to work with existing security mechanisms,
 * So that @Roles decorators, securityCheck, and @Restricted work seamlessly.
 *
 * This test file verifies the security integration components:
 * - BetterAuthUserMapper (hasRole functionality)
 * - BetterAuthMiddleware (session to user mapping)
 * - AuthGuard integration with Better-Auth users
 */

import { MongoClient } from 'mongodb';
import { connect, Connection } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { RoleEnum } from '../../src';
import envConfig from '../../src/config.env';
// Import directly from source files to avoid barrel export issues with DI tokens
import { CoreBetterAuthUserMapper } from '../../src/core/modules/better-auth/core-better-auth-user.mapper';
import { CoreBetterAuthMiddleware } from '../../src/core/modules/better-auth/core-better-auth.middleware';
import { CoreBetterAuthService } from '../../src/core/modules/better-auth/core-better-auth.service';

describe('Story: BetterAuth Security Integration', () => {
  // Database connection - shared across tests
  let mongoClient: MongoClient;
  let mongooseConnection: Connection;
  let db: any;

  // The mapper to test - instantiated directly with mongoose connection
  let mapper: CoreBetterAuthUserMapper;

  beforeAll(async () => {
    try {
      // Connect to MongoDB directly
      mongoClient = await MongoClient.connect(envConfig.mongoose.uri);
      db = mongoClient.db();

      // Create mongoose connection for the mapper
      mongooseConnection = (await connect(envConfig.mongoose.uri)).connection;

      // Instantiate the mapper directly with the connection
      // Using Object.create to bypass DI and set the connection manually
      mapper = new CoreBetterAuthUserMapper(mongooseConnection);
    } catch (e) {
      console.error('beforeAll error:', e);
      throw e;
    }
  });

  afterAll(async () => {
    if (mongooseConnection) {
      await mongooseConnection.close();
    }
    if (mongoClient) {
      await mongoClient.close();
    }
  });

  // ===================================================================================================================
  // BetterAuthUserMapper Tests
  // ===================================================================================================================

  describe('CoreBetterAuthUserMapper', () => {
    describe('mapSessionUser', () => {
      it('should return null for null session user', async () => {
        const result = await mapper.mapSessionUser(null as any);
        expect(result).toBeNull();
      });

      it('should return null for session user without id', async () => {
        const result = await mapper.mapSessionUser({ email: 'test@test.com' } as any);
        expect(result).toBeNull();
      });

      it('should return null for session user without email', async () => {
        const result = await mapper.mapSessionUser({ id: 'test-id' } as any);
        expect(result).toBeNull();
      });

      it('should map session user with default roles when user not in database', async () => {
        const sessionUser = {
          email: `nonexistent-${Date.now()}@test.com`,
          emailVerified: true,
          id: 'better-auth-id-123',
          name: 'Test User',
        };

        const result = await mapper.mapSessionUser(sessionUser);

        expect(result).not.toBeNull();
        expect(result!.iamId).toBe(sessionUser.id);
        expect(result!.email).toBe(sessionUser.email);
        expect(result!.roles).toEqual([]); // S_ roles are system checks, not stored in user.roles
        expect(result!._authenticatedViaBetterAuth).toBe(true);
        expect(typeof result!.hasRole).toBe('function');
      });

      it('should map session user with roles from database when user exists', async () => {
        // Create a test user in database
        const testEmail = `mapper-test-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
        const insertResult = await db.collection('users').insertOne({
          createdAt: new Date(),
          email: testEmail,
          roles: [RoleEnum.ADMIN, 'custom-role'],
          updatedAt: new Date(),
          verified: true,
        });
        const userId = insertResult.insertedId;

        try {
          const sessionUser = {
            email: testEmail,
            emailVerified: true,
            id: 'better-auth-id-456',
            name: 'Database User',
          };

          const result = await mapper.mapSessionUser(sessionUser);

          expect(result).not.toBeNull();
          expect(result!.id).toBe(userId.toString());
          expect(result!.iamId).toBe(sessionUser.id);
          expect(result!.roles).toContain(RoleEnum.ADMIN);
          expect(result!.roles).toContain('custom-role');
          expect(result!._authenticatedViaBetterAuth).toBe(true);
        } finally {
          // Cleanup
          await db.collection('users').deleteOne({ _id: userId });
        }
      });
    });

    describe('hasRole functionality', () => {
      it('should return true for S_EVERYONE', async () => {
        const sessionUser = {
          email: `hasrole-test-${Date.now()}@test.com`,
          emailVerified: false,
          id: 'test-id',
        };

        const result = await mapper.mapSessionUser(sessionUser);

        expect(result!.hasRole(RoleEnum.S_EVERYONE)).toBe(true);
        expect(result!.hasRole([RoleEnum.S_EVERYONE])).toBe(true);
      });

      it('should return true for S_USER when authenticated', async () => {
        const sessionUser = {
          email: `hasrole-test-${Date.now()}@test.com`,
          emailVerified: false,
          id: 'test-id',
        };

        const result = await mapper.mapSessionUser(sessionUser);

        expect(result!.hasRole(RoleEnum.S_USER)).toBe(true);
        expect(result!.hasRole([RoleEnum.S_USER])).toBe(true);
      });

      it('should return false for S_NO_ONE', async () => {
        const sessionUser = {
          email: `hasrole-test-${Date.now()}@test.com`,
          emailVerified: true,
          id: 'test-id',
        };

        const result = await mapper.mapSessionUser(sessionUser);

        expect(result!.hasRole(RoleEnum.S_NO_ONE)).toBe(false);
        expect(result!.hasRole([RoleEnum.S_NO_ONE])).toBe(false);
      });

      it('should return true for S_VERIFIED when emailVerified is true', async () => {
        const sessionUser = {
          email: `hasrole-test-${Date.now()}@test.com`,
          emailVerified: true,
          id: 'test-id',
        };

        const result = await mapper.mapSessionUser(sessionUser);

        expect(result!.hasRole(RoleEnum.S_VERIFIED)).toBe(true);
      });

      it('should return false for S_VERIFIED when emailVerified is false', async () => {
        const sessionUser = {
          email: `hasrole-test-${Date.now()}@test.com`,
          emailVerified: false,
          id: 'test-id',
        };

        const result = await mapper.mapSessionUser(sessionUser);

        expect(result!.hasRole(RoleEnum.S_VERIFIED)).toBe(false);
      });

      it('should check actual roles from database', async () => {
        // Create a test user with specific roles
        const testEmail = `hasrole-db-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
        const insertResult = await db.collection('users').insertOne({
          createdAt: new Date(),
          email: testEmail,
          roles: [RoleEnum.ADMIN, 'editor'],
          updatedAt: new Date(),
        });
        const userId = insertResult.insertedId;

        try {
          const sessionUser = {
            email: testEmail,
            emailVerified: true,
            id: 'better-auth-id',
          };

          const result = await mapper.mapSessionUser(sessionUser);

          // Should have ADMIN role
          expect(result!.hasRole(RoleEnum.ADMIN)).toBe(true);
          expect(result!.hasRole('editor')).toBe(true);

          // Should not have roles not assigned
          expect(result!.hasRole('superadmin')).toBe(false);
          expect(result!.hasRole('moderator')).toBe(false);

          // Should return true if any of the roles match
          expect(result!.hasRole([RoleEnum.ADMIN, 'superadmin'])).toBe(true);
          expect(result!.hasRole(['editor', 'moderator'])).toBe(true);

          // Should return false if none of the roles match
          expect(result!.hasRole(['superadmin', 'moderator'])).toBe(false);
        } finally {
          await db.collection('users').deleteOne({ _id: userId });
        }
      });

      it('should handle string and array input for hasRole', async () => {
        const sessionUser = {
          email: `hasrole-input-${Date.now()}@test.com`,
          emailVerified: true,
          id: 'test-id',
        };

        const result = await mapper.mapSessionUser(sessionUser);

        // String input
        expect(result!.hasRole(RoleEnum.S_USER)).toBe(true);

        // Array input
        expect(result!.hasRole([RoleEnum.S_USER])).toBe(true);
        expect(result!.hasRole([RoleEnum.S_USER, RoleEnum.ADMIN])).toBe(true);
      });
    });

    describe('linkOrCreateUser', () => {
      it('should return null for session user without email', async () => {
        const result = await mapper.linkOrCreateUser({ id: 'test' } as any);
        expect(result).toBeNull();
      });

      it('should create new user if not exists', async () => {
        const testEmail = `link-new-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
        const sessionUser = {
          email: testEmail,
          emailVerified: true,
          id: 'better-auth-link-id',
          name: 'Link Test User',
        };

        try {
          const result = await mapper.linkOrCreateUser(sessionUser);

          expect(result).not.toBeNull();
          expect(result.email).toBe(testEmail);
          expect(result.iamId).toBe(sessionUser.id);
          expect(result.roles).toEqual([]); // S_ roles are system checks, not stored in user.roles
        } finally {
          await db.collection('users').deleteOne({ email: testEmail });
        }
      });

      it('should link existing user', async () => {
        const testEmail = `link-existing-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;

        // Create existing user
        await db.collection('users').insertOne({
          createdAt: new Date(),
          email: testEmail,
          roles: [RoleEnum.ADMIN],
          updatedAt: new Date(),
        });

        try {
          const sessionUser = {
            email: testEmail,
            emailVerified: true,
            id: 'better-auth-link-existing-id',
            name: 'Updated Name',
          };

          const result = await mapper.linkOrCreateUser(sessionUser);

          expect(result).not.toBeNull();
          expect(result.iamId).toBe(sessionUser.id);
          expect(result.firstName).toBe('Updated');
          // Original roles should be preserved
          expect(result.roles).toContain(RoleEnum.ADMIN);
        } finally {
          await db.collection('users').deleteOne({ email: testEmail });
        }
      });
    });

    describe('_authenticatedViaBetterAuth marker', () => {
      it('should always set _authenticatedViaBetterAuth to true', async () => {
        const sessionUser = {
          email: `marker-test-${Date.now()}@test.com`,
          emailVerified: true,
          id: 'marker-test-id',
        };

        const result = await mapper.mapSessionUser(sessionUser);

        expect(result!._authenticatedViaBetterAuth).toBe(true);
      });

      it('should be used by AuthGuard to identify Better-Auth users', async () => {
        const sessionUser = {
          email: `authguard-test-${Date.now()}@test.com`,
          emailVerified: true,
          id: 'auth-guard-test-id',
        };

        const result = await mapper.mapSessionUser(sessionUser);

        // This is the check the AuthGuard performs
        const isBetterAuthUser = result!._authenticatedViaBetterAuth === true;
        expect(isBetterAuthUser).toBe(true);
      });
    });
  });

  // ===================================================================================================================
  // BetterAuthMiddleware Tests
  // ===================================================================================================================

  describe('CoreBetterAuthMiddleware', () => {
    let middleware: CoreBetterAuthMiddleware;
    let mockBetterAuthService: any;
    let mockUserMapper: any;

    beforeEach(() => {
      mockBetterAuthService = {
        getApi: vi.fn().mockReturnValue(null),
        getBasePath: vi.fn().mockReturnValue('/iam'),
        getConfig: vi.fn().mockReturnValue({ basePath: '/iam' }),
        getSessionByToken: vi.fn().mockResolvedValue({ session: null, user: null }),
        isEnabled: vi.fn().mockReturnValue(false),
      };

      mockUserMapper = {
        mapSessionUser: vi.fn().mockResolvedValue(null),
      };

      // Directly instantiate middleware with mocks to avoid DI resolution issues
      middleware = new CoreBetterAuthMiddleware(
        mockBetterAuthService as CoreBetterAuthService,
        mockUserMapper as CoreBetterAuthUserMapper,
      );
    });

    it('should skip processing when Better-Auth is disabled', async () => {
      const req: any = {};
      const res: any = {};
      const next = vi.fn();

      await middleware.use(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeUndefined();
    });

    it('should skip processing when user is already set', async () => {
      mockBetterAuthService.isEnabled.mockReturnValue(true);

      const existingUser = { hasRole: () => true, id: 'existing-user' };
      const req: any = { user: existingUser };
      const res: any = {};
      const next = vi.fn();

      await middleware.use(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBe(existingUser);
    });

    it('should call next even when session retrieval fails', async () => {
      mockBetterAuthService.isEnabled.mockReturnValue(true);
      mockBetterAuthService.getApi.mockReturnValue({
        getSession: vi.fn().mockRejectedValue(new Error('Session error')),
      });

      const req: any = { headers: {} };
      const res: any = {};
      const next = vi.fn();

      await middleware.use(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should map user when session is valid', async () => {
      const mockSession = {
        session: { id: 'session-id' },
        user: { email: 'test@test.com', id: 'user-id' },
      };

      const mappedUser = {
        _authenticatedViaBetterAuth: true,
        email: 'test@test.com',
        hasRole: () => true,
        iamId: 'user-id',
        id: 'user-id',
        roles: [RoleEnum.S_USER],
      };

      mockBetterAuthService.isEnabled.mockReturnValue(true);
      mockBetterAuthService.getApi.mockReturnValue({
        getSession: vi.fn().mockResolvedValue(mockSession),
      });
      mockUserMapper.mapSessionUser.mockResolvedValue(mappedUser);

      const req: any = { headers: {} };
      const res: any = {};
      const next = vi.fn();

      await middleware.use(req, res, next);

      expect(next).toHaveBeenCalled();
      // User object is spread with _authenticatedViaBetterAuth flag, so use toMatchObject
      expect(req.user).toMatchObject(mappedUser);
      expect(req.user._authenticatedViaBetterAuth).toBe(true);
      expect(req.betterAuthSession).toBe(mockSession);
      expect(req.betterAuthUser).toBe(mockSession.user);
    });
  });

  // ===================================================================================================================
  // Integration Tests: Security Decorators with Better-Auth Users
  // ===================================================================================================================

  describe('Security Integration', () => {
    describe('Role checking with mapped users', () => {
      it('should work with RolesGuard role checking logic', async () => {
        // Create user with specific roles
        const testEmail = `roles-guard-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
        const insertResult = await db.collection('users').insertOne({
          createdAt: new Date(),
          email: testEmail,
          roles: [RoleEnum.ADMIN],
          updatedAt: new Date(),
        });

        try {
          const sessionUser = {
            email: testEmail,
            emailVerified: true,
            id: 'roles-guard-test',
          };

          const user = await mapper.mapSessionUser(sessionUser);

          // Simulate RolesGuard checks
          const adminRoles = [RoleEnum.ADMIN];
          const userRoles = [RoleEnum.S_USER];
          const publicRoles = [RoleEnum.S_EVERYONE];
          const restrictedRoles = [RoleEnum.S_NO_ONE];

          expect(user!.hasRole(adminRoles)).toBe(true);
          expect(user!.hasRole(userRoles)).toBe(true);
          expect(user!.hasRole(publicRoles)).toBe(true);
          expect(user!.hasRole(restrictedRoles)).toBe(false);
        } finally {
          await db.collection('users').deleteOne({ _id: insertResult.insertedId });
        }
      });

      it('should work with multiple roles requirement', async () => {
        const testEmail = `multi-roles-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
        const insertResult = await db.collection('users').insertOne({
          createdAt: new Date(),
          email: testEmail,
          roles: ['editor', 'reviewer'],
          updatedAt: new Date(),
        });

        try {
          const sessionUser = {
            email: testEmail,
            emailVerified: true,
            id: 'multi-roles-test',
          };

          const user = await mapper.mapSessionUser(sessionUser);

          // User has at least one of these roles
          expect(user!.hasRole(['editor', 'admin'])).toBe(true);
          expect(user!.hasRole(['reviewer', 'superadmin'])).toBe(true);

          // User has none of these roles
          expect(user!.hasRole(['admin', 'superadmin'])).toBe(false);
        } finally {
          await db.collection('users').deleteOne({ _id: insertResult.insertedId });
        }
      });

      it('should handle verified users correctly', async () => {
        const sessionUserVerified = {
          email: `verified-${Date.now()}@test.com`,
          emailVerified: true,
          id: 'verified-user',
        };

        const sessionUserUnverified = {
          email: `unverified-${Date.now()}@test.com`,
          emailVerified: false,
          id: 'unverified-user',
        };

        const verifiedUser = await mapper.mapSessionUser(sessionUserVerified);
        const unverifiedUser = await mapper.mapSessionUser(sessionUserUnverified);

        expect(verifiedUser!.hasRole(RoleEnum.S_VERIFIED)).toBe(true);
        expect(unverifiedUser!.hasRole(RoleEnum.S_VERIFIED)).toBe(false);
      });

      it('should use database verified field for S_VERIFIED check', async () => {
        // Create user with verified=true in database but emailVerified=false in session
        const testEmail = `db-verified-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
        const insertResult = await db.collection('users').insertOne({
          createdAt: new Date(),
          email: testEmail,
          roles: [RoleEnum.S_USER],
          updatedAt: new Date(),
          verified: true, // Database says verified
        });

        try {
          const sessionUser = {
            email: testEmail,
            emailVerified: false, // Session says not verified
            id: 'db-verified-test',
          };

          const user = await mapper.mapSessionUser(sessionUser);

          // Should be verified because database verified=true takes precedence
          expect(user!.verified).toBe(true);
          expect(user!.hasRole(RoleEnum.S_VERIFIED)).toBe(true);
        } finally {
          await db.collection('users').deleteOne({ _id: insertResult.insertedId });
        }
      });

      it('should use emailVerified when database verified is false', async () => {
        // Create user with verified=false in database but emailVerified=true in session
        const testEmail = `email-verified-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
        const insertResult = await db.collection('users').insertOne({
          createdAt: new Date(),
          email: testEmail,
          roles: [RoleEnum.S_USER],
          updatedAt: new Date(),
          verified: false, // Database says not verified
        });

        try {
          const sessionUser = {
            email: testEmail,
            emailVerified: true, // Session says verified
            id: 'email-verified-test',
          };

          const user = await mapper.mapSessionUser(sessionUser);

          // Should be verified because emailVerified=true (OR condition)
          expect(user!.verified).toBe(true);
          expect(user!.hasRole(RoleEnum.S_VERIFIED)).toBe(true);
        } finally {
          await db.collection('users').deleteOne({ _id: insertResult.insertedId });
        }
      });
    });

    describe('User identification for securityCheck', () => {
      it('should provide user id for owner checks', async () => {
        const testEmail = `owner-check-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
        const insertResult = await db.collection('users').insertOne({
          createdAt: new Date(),
          email: testEmail,
          roles: [RoleEnum.S_USER],
          updatedAt: new Date(),
        });

        try {
          const sessionUser = {
            email: testEmail,
            emailVerified: true,
            id: 'better-auth-owner-id',
          };

          const user = await mapper.mapSessionUser(sessionUser);

          // User id should match database id (for owner checks)
          expect(user!.id).toBe(insertResult.insertedId.toString());

          // Simulate owner check in securityCheck
          const resourceOwnerId = insertResult.insertedId.toString();
          const isOwner = user!.id === resourceOwnerId;
          expect(isOwner).toBe(true);
        } finally {
          await db.collection('users').deleteOne({ _id: insertResult.insertedId });
        }
      });

      it('should use Better-Auth id as fallback when user not in database', async () => {
        const sessionUser = {
          email: `fallback-${Date.now()}@test.com`,
          emailVerified: true,
          id: 'fallback-better-auth-id',
        };

        const user = await mapper.mapSessionUser(sessionUser);

        // When user not in database, Better-Auth id is used as fallback
        expect(user!.id).toBe(sessionUser.id);
        expect(user!.iamId).toBe(sessionUser.id);
      });
    });
  });

  // ===================================================================================================================
  // Edge Cases and Error Handling
  // ===================================================================================================================

  describe('Edge Cases', () => {
    it('should handle user with empty roles array', async () => {
      const testEmail = `empty-roles-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
      const insertResult = await db.collection('users').insertOne({
        createdAt: new Date(),
        email: testEmail,
        roles: [],
        updatedAt: new Date(),
      });

      try {
        const sessionUser = {
          email: testEmail,
          emailVerified: true,
          id: 'empty-roles-user',
        };

        const user = await mapper.mapSessionUser(sessionUser);

        expect(user!.roles).toEqual([]);
        expect(user!.hasRole(RoleEnum.ADMIN)).toBe(false);
        // Special roles should still work
        expect(user!.hasRole(RoleEnum.S_USER)).toBe(true);
        expect(user!.hasRole(RoleEnum.S_EVERYONE)).toBe(true);
      } finally {
        await db.collection('users').deleteOne({ _id: insertResult.insertedId });
      }
    });

    it('should handle user with null roles', async () => {
      const testEmail = `null-roles-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
      const insertResult = await db.collection('users').insertOne({
        createdAt: new Date(),
        email: testEmail,
        roles: null,
        updatedAt: new Date(),
      });

      try {
        const sessionUser = {
          email: testEmail,
          emailVerified: true,
          id: 'null-roles-user',
        };

        const user = await mapper.mapSessionUser(sessionUser);

        expect(user!.roles).toEqual([]);
        // Special roles should still work
        expect(user!.hasRole(RoleEnum.S_USER)).toBe(true);
      } finally {
        await db.collection('users').deleteOne({ _id: insertResult.insertedId });
      }
    });

    it('should handle session user with all optional fields', async () => {
      const sessionUser = {
        email: `minimal-${Date.now()}@test.com`,
        id: 'minimal-user',
        // No name, image, emailVerified, etc.
      };

      const user = await mapper.mapSessionUser(sessionUser);

      expect(user).not.toBeNull();
      expect(user!.iamId).toBe(sessionUser.id);
      expect(user!.email).toBe(sessionUser.email);
      expect(user!._authenticatedViaBetterAuth).toBe(true);
    });

    it('should parse name into firstName and lastName in linkOrCreateUser', async () => {
      const testEmail = `name-parse-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;

      try {
        const sessionUser = {
          email: testEmail,
          emailVerified: true,
          id: 'name-parse-user',
          name: 'John Michael Doe',
        };

        await mapper.linkOrCreateUser(sessionUser);

        const dbUser = await db.collection('users').findOne({ email: testEmail });

        expect(dbUser.firstName).toBe('John');
        expect(dbUser.lastName).toBe('Michael Doe');
      } finally {
        await db.collection('users').deleteOne({ email: testEmail });
      }
    });
  });
});
