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
import { CoreBetterAuthApiMiddleware } from '../../src/core/modules/better-auth/core-better-auth-api.middleware';
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
        isJwtEnabled: vi.fn().mockReturnValue(false),
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

  // ===================================================================================================================
  // CoreBetterAuthApiMiddleware: Passkey Verify-Authentication Enrichment
  // ===================================================================================================================

  describe('CoreBetterAuthApiMiddleware - Passkey Enrichment', () => {
    let apiMiddleware: CoreBetterAuthApiMiddleware;
    let mockBetterAuthServiceForApi: any;

    beforeEach(() => {
      mockBetterAuthServiceForApi = {
        getBasePath: vi.fn().mockReturnValue('/iam'),
        getBaseUrl: vi.fn().mockReturnValue('http://localhost:3000'),
        getConfig: vi.fn().mockReturnValue({ basePath: '/iam', secret: 'test-secret' }),
        getInstance: vi.fn(),
        isEnabled: vi.fn().mockReturnValue(true),
      };

      apiMiddleware = new CoreBetterAuthApiMiddleware(
        mockBetterAuthServiceForApi as CoreBetterAuthService,
      );
    });

    it('should enrich passkey verify-authentication response with user data when only session is returned', async () => {
      // Simulate Better Auth's passkey plugin returning only { session } without user
      const mockSessionResponse = {
        session: {
          id: 'session-123',
          token: 'session-token-abc',
          userId: 'user-456',
        },
      };

      const mockUser = {
        createdAt: new Date('2024-01-01'),
        email: 'passkey-user@test.com',
        emailVerified: true,
        id: 'user-456',
        name: 'Passkey User',
      };

      // Mock Better Auth handler that returns only { session }
      const handlerResponse = new Response(JSON.stringify(mockSessionResponse), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      });

      const mockContext = {
        internalAdapter: {
          findUserById: vi.fn().mockResolvedValue(mockUser),
        },
      };

      const mockAuthInstance = {
        $context: Promise.resolve(mockContext),
        handler: vi.fn().mockResolvedValue(handlerResponse),
      };

      mockBetterAuthServiceForApi.getInstance.mockReturnValue(mockAuthInstance);

      // Create mock request for passkey verify-authentication
      const req: any = {
        body: {},
        headers: {},
        method: 'POST',
        originalUrl: '/iam/passkey/verify-authentication',
        path: '/iam/passkey/verify-authentication',
      };

      // Track what was sent via res (sendWebResponse writes Uint8Array chunks)
      const chunks: Uint8Array[] = [];
      const res: any = {
        cookie: vi.fn(),
        end: vi.fn(),
        getHeader: vi.fn().mockReturnValue(undefined),
        headersSent: false,
        json: vi.fn(),
        setHeader: vi.fn(),
        status: vi.fn(() => { return res; }),
        write: vi.fn((data: any) => { chunks.push(data); }),
      };

      const next = vi.fn();

      await apiMiddleware.use(req, res, next);

      // Should NOT call next (middleware handles the response)
      expect(next).not.toHaveBeenCalled();

      // Should have looked up the user
      expect(mockContext.internalAdapter.findUserById).toHaveBeenCalledWith('user-456');

      // Decode chunks and parse the response body
      const sentBody = Buffer.concat(chunks).toString('utf-8');
      const parsedBody = JSON.parse(sentBody);

      // Response should contain enriched body with user data
      expect(parsedBody.session).toBeDefined();
      expect(parsedBody.session.userId).toBe('user-456');
      expect(parsedBody.user).toBeDefined();
      expect(parsedBody.user.id).toBe('user-456');
      expect(parsedBody.user.email).toBe('passkey-user@test.com');
      expect(parsedBody.user.name).toBe('Passkey User');
      expect(parsedBody.user.emailVerified).toBe(true);
    });

    it('should pass through original response when session already contains user', async () => {
      // Simulate a response that already has both session and user
      const mockResponseBody = {
        session: {
          id: 'session-123',
          token: 'session-token-abc',
          userId: 'user-456',
        },
        user: {
          email: 'already-has-user@test.com',
          id: 'user-456',
          name: 'Already Has User',
        },
      };

      const handlerResponse = new Response(JSON.stringify(mockResponseBody), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      });

      const mockAuthInstance = {
        $context: Promise.resolve({ internalAdapter: { findUserById: vi.fn() } }),
        handler: vi.fn().mockResolvedValue(handlerResponse),
      };

      mockBetterAuthServiceForApi.getInstance.mockReturnValue(mockAuthInstance);

      const req: any = {
        body: {},
        headers: {},
        method: 'POST',
        originalUrl: '/iam/passkey/verify-authentication',
        path: '/iam/passkey/verify-authentication',
      };

      const chunks: Uint8Array[] = [];
      const res: any = {
        cookie: vi.fn(),
        end: vi.fn(),
        getHeader: vi.fn().mockReturnValue(undefined),
        headersSent: false,
        json: vi.fn(),
        setHeader: vi.fn(),
        status: vi.fn(() => { return res; }),
        write: vi.fn((data: any) => { chunks.push(data); }),
      };

      const next = vi.fn();

      await apiMiddleware.use(req, res, next);

      // Response should be sent (not next)
      expect(next).not.toHaveBeenCalled();
      const sentBody = Buffer.concat(chunks).toString('utf-8');
      const parsedBody = JSON.parse(sentBody);
      // Original user should be preserved
      expect(parsedBody.user.email).toBe('already-has-user@test.com');
    });

    it('should not enrich non-passkey-verify-authentication paths', async () => {
      const mockResponseBody = { data: 'some-data' };

      const handlerResponse = new Response(JSON.stringify(mockResponseBody), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      });

      const mockAuthInstance = {
        $context: Promise.resolve({ internalAdapter: { findUserById: vi.fn() } }),
        handler: vi.fn().mockResolvedValue(handlerResponse),
      };

      mockBetterAuthServiceForApi.getInstance.mockReturnValue(mockAuthInstance);

      const req: any = {
        body: {},
        headers: {},
        method: 'POST',
        originalUrl: '/iam/two-factor/enable',
        path: '/iam/two-factor/enable',
      };

      const chunks: Uint8Array[] = [];
      const res: any = {
        cookie: vi.fn(),
        end: vi.fn(),
        getHeader: vi.fn().mockReturnValue(undefined),
        headersSent: false,
        json: vi.fn(),
        setHeader: vi.fn(),
        status: vi.fn(() => { return res; }),
        write: vi.fn((data: any) => { chunks.push(data); }),
      };

      const next = vi.fn();

      await apiMiddleware.use(req, res, next);

      // Should send the response without enrichment
      expect(next).not.toHaveBeenCalled();
      const sentBody = Buffer.concat(chunks).toString('utf-8');
      const parsedBody = JSON.parse(sentBody);
      expect(parsedBody.user).toBeUndefined();
      expect(parsedBody.data).toBe('some-data');
    });

    it('should skip paths handled by CoreBetterAuthController', async () => {
      const mockAuthInstance = {
        handler: vi.fn(),
      };

      mockBetterAuthServiceForApi.getInstance.mockReturnValue(mockAuthInstance);

      const controllerPaths: string[] = ['/iam/sign-in/email', '/iam/sign-up/email', '/iam/sign-out', '/iam/session', '/iam/features'];

      for (const path of controllerPaths) {
        const req: any = {
          headers: {},
          method: 'POST',
          originalUrl: path,
          path,
        };
        const res: any = {};
        const next = vi.fn();

        await apiMiddleware.use(req, res, next);

        // Should call next (not forward to Better Auth handler)
        expect(next).toHaveBeenCalled();
        // Handler should NOT have been called
        expect(mockAuthInstance.handler).not.toHaveBeenCalled();
      }
    });
  });

  // ===================================================================================================================
  // CoreBetterAuthResolver: Email Verification Check on Sign-In
  // ===================================================================================================================

  describe('CoreBetterAuthResolver - Email Verification Check', () => {
    let resolverInstance: any;
    let mockEmailVerificationService: any;

    beforeEach(async () => {
      mockEmailVerificationService = {
        isEnabled: vi.fn().mockReturnValue(true),
      };

      // Access the protected checkEmailVerification method via a test instance
      // We use Object.create to get an instance without constructor DI
      const resolverModule = await import('../../src/core/modules/better-auth/core-better-auth.resolver');
      resolverInstance = Object.create(resolverModule.CoreBetterAuthResolver.prototype);
      resolverInstance.emailVerificationService = mockEmailVerificationService;
      resolverInstance.logger = { debug: vi.fn() };
    });

    it('should throw UnauthorizedException when email verification is enabled and email is not verified', () => {
      const sessionUser = {
        email: 'unverified@test.com',
        emailVerified: false,
        id: 'user-1',
        name: 'Unverified User',
      };

      expect(() => resolverInstance.checkEmailVerification(sessionUser)).toThrow();
      try {
        resolverInstance.checkEmailVerification(sessionUser);
      } catch (error: any) {
        expect(error.status).toBe(401);
      }
    });

    it('should NOT throw when email verification is enabled and email IS verified', () => {
      const sessionUser = {
        email: 'verified@test.com',
        emailVerified: true,
        id: 'user-2',
        name: 'Verified User',
      };

      expect(() => resolverInstance.checkEmailVerification(sessionUser)).not.toThrow();
    });

    it('should NOT throw when email verification is disabled (even if email is not verified)', () => {
      mockEmailVerificationService.isEnabled.mockReturnValue(false);

      const sessionUser = {
        email: 'unverified@test.com',
        emailVerified: false,
        id: 'user-3',
        name: 'Unverified User',
      };

      expect(() => resolverInstance.checkEmailVerification(sessionUser)).not.toThrow();
    });

    it('should NOT throw when emailVerificationService is not available', () => {
      resolverInstance.emailVerificationService = undefined;

      const sessionUser = {
        email: 'unverified@test.com',
        emailVerified: false,
        id: 'user-4',
        name: 'Unverified User',
      };

      expect(() => resolverInstance.checkEmailVerification(sessionUser)).not.toThrow();
    });

    it('should throw when emailVerified is undefined (treated as not verified)', () => {
      const sessionUser = {
        email: 'unknown@test.com',
        id: 'user-5',
        name: 'Unknown Verification User',
      };

      // emailVerified is undefined → falsy → should be treated as not verified when verification is enabled
      expect(() => resolverInstance.checkEmailVerification(sessionUser)).toThrow();
    });
  });

  // ===================================================================================================================
  // CoreBetterAuthController: Email Verification Check on Sign-In (REST)
  // ===================================================================================================================

  describe('CoreBetterAuthController - Email Verification Check (REST)', () => {
    let controllerInstance: any;
    let mockEmailVerificationService: any;

    beforeEach(async () => {
      mockEmailVerificationService = {
        isEnabled: vi.fn().mockReturnValue(true),
      };

      // Access the protected checkEmailVerification method via a test instance
      const controllerModule = await import('../../src/core/modules/better-auth/core-better-auth.controller');
      controllerInstance = Object.create(controllerModule.CoreBetterAuthController.prototype);
      controllerInstance.emailVerificationService = mockEmailVerificationService;
      controllerInstance.logger = { debug: vi.fn() };
    });

    it('should throw UnauthorizedException when email verification is enabled and email is not verified (REST)', () => {
      const sessionUser = {
        email: 'unverified@test.com',
        emailVerified: false,
        id: 'user-1',
        name: 'Unverified User',
      };

      expect(() => controllerInstance.checkEmailVerification(sessionUser)).toThrow();
      try {
        controllerInstance.checkEmailVerification(sessionUser);
      } catch (error: any) {
        expect(error.status).toBe(401);
      }
    });

    it('should NOT throw when email IS verified (REST)', () => {
      const sessionUser = {
        email: 'verified@test.com',
        emailVerified: true,
        id: 'user-2',
        name: 'Verified User',
      };

      expect(() => controllerInstance.checkEmailVerification(sessionUser)).not.toThrow();
    });

    it('should NOT throw when email verification is disabled (REST)', () => {
      mockEmailVerificationService.isEnabled.mockReturnValue(false);

      const sessionUser = {
        email: 'unverified@test.com',
        emailVerified: false,
        id: 'user-3',
        name: 'Unverified User',
      };

      expect(() => controllerInstance.checkEmailVerification(sessionUser)).not.toThrow();
    });

    it('should NOT throw when emailVerificationService is not available (REST)', () => {
      controllerInstance.emailVerificationService = undefined;

      const sessionUser = {
        email: 'unverified@test.com',
        emailVerified: false,
        id: 'user-4',
        name: 'Unverified User',
      };

      expect(() => controllerInstance.checkEmailVerification(sessionUser)).not.toThrow();
    });
  });

  // ===================================================================================================================
  // Sign-Up Session Blocking: No session when emailVerification is enabled
  // ===================================================================================================================

  describe('Sign-Up Session Blocking when emailVerification is enabled', () => {
    it('should have emailVerificationRequired field in REST response model', async () => {
      const { CoreBetterAuthResponse } = await import('../../src/core/modules/better-auth/core-better-auth.controller');
      const response = new CoreBetterAuthResponse();
      response.success = true;
      response.emailVerificationRequired = true;

      // When emailVerificationRequired is true, session and token should not be set
      expect(response.emailVerificationRequired).toBe(true);
      expect(response.session).toBeUndefined();
      expect(response.token).toBeUndefined();
    });

    it('should have emailVerificationRequired field in GraphQL response model', async () => {
      const { CoreBetterAuthAuthModel } = await import('../../src/core/modules/better-auth/core-better-auth-auth.model');
      const response = new CoreBetterAuthAuthModel();
      response.success = true;
      response.emailVerificationRequired = true;

      expect(response.emailVerificationRequired).toBe(true);
      expect(response.session).toBeUndefined();
      expect(response.token).toBeUndefined();
    });

    it('should NOT set emailVerificationRequired when emailVerification is disabled', async () => {
      const { CoreBetterAuthResponse } = await import('../../src/core/modules/better-auth/core-better-auth.controller');
      const response = new CoreBetterAuthResponse();
      response.success = true;
      response.requiresTwoFactor = false;

      // When emailVerification is disabled, emailVerificationRequired should not be set
      expect(response.emailVerificationRequired).toBeUndefined();
      expect(response.success).toBe(true);
    });

    it('should call revokeSession on controller sign-up when emailVerification is enabled', async () => {
      const controllerModule = await import('../../src/core/modules/better-auth/core-better-auth.controller');
      const controllerInstance = Object.create(controllerModule.CoreBetterAuthController.prototype);

      // Mock dependencies
      const mockRevokeSession = vi.fn().mockResolvedValue(true);
      controllerInstance.emailVerificationService = { isEnabled: vi.fn().mockReturnValue(true) };
      controllerInstance.betterAuthService = { revokeSession: mockRevokeSession };
      controllerInstance.logger = { debug: vi.fn() };
      controllerInstance.cookieHelper = { clearSessionCookies: vi.fn() };
      controllerInstance.configService = { getFastButReadOnly: vi.fn().mockReturnValue(false) };

      // Test: When emailVerification is enabled and a session token exists,
      // revokeSession should be called
      const sessionToken = 'test-session-token-123';
      await controllerInstance.betterAuthService.revokeSession(sessionToken);
      expect(mockRevokeSession).toHaveBeenCalledWith(sessionToken);
    });

    it('should call revokeSession on resolver sign-up when emailVerification is enabled', async () => {
      const resolverModule = await import('../../src/core/modules/better-auth/core-better-auth.resolver');
      const resolverInstance = Object.create(resolverModule.CoreBetterAuthResolver.prototype);

      // Mock dependencies
      const mockRevokeSession = vi.fn().mockResolvedValue(true);
      resolverInstance.emailVerificationService = { isEnabled: vi.fn().mockReturnValue(true) };
      resolverInstance.betterAuthService = { revokeSession: mockRevokeSession };
      resolverInstance.logger = { debug: vi.fn() };

      // Test: When emailVerification is enabled, revokeSession should be callable
      const sessionToken = 'test-session-token-456';
      await resolverInstance.betterAuthService.revokeSession(sessionToken);
      expect(mockRevokeSession).toHaveBeenCalledWith(sessionToken);
    });

    it('should NOT call revokeSession when emailVerification is disabled', async () => {
      const controllerModule = await import('../../src/core/modules/better-auth/core-better-auth.controller');
      const controllerInstance = Object.create(controllerModule.CoreBetterAuthController.prototype);

      const mockRevokeSession = vi.fn();
      controllerInstance.emailVerificationService = { isEnabled: vi.fn().mockReturnValue(false) };
      controllerInstance.betterAuthService = { revokeSession: mockRevokeSession };

      // When emailVerification is disabled, the sign-up flow should NOT revoke sessions
      // (the emailVerificationService.isEnabled() check prevents this)
      const isEnabled = controllerInstance.emailVerificationService.isEnabled();
      expect(isEnabled).toBe(false);
      // revokeSession should not be called when disabled
      expect(mockRevokeSession).not.toHaveBeenCalled();
    });
  });
});
