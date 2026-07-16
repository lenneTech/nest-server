/**
 * Story: Better-Auth Privilege-Escalation Prevention (`input: false` on server-managed fields)
 *
 * Regression test for a confirmed vertical privilege-escalation vulnerability (OWASP A01):
 * ANY authenticated user — including a freshly self-registered one — could make themselves
 * admin via `POST /iam/update-user {"roles":["admin"]}`.
 *
 * Root cause: the server-managed `roles` field was registered as a Better-Auth
 * `additionalField` WITHOUT `input: false`. Better-Auth defaults `input: true`, so it accepted
 * the field from client input. Because `/iam/update-user` is NOT in `CONTROLLER_HANDLED_PATHS`,
 * the API middleware forwards it RAW to Better-Auth's native handler under `sessionMiddleware`
 * (any authenticated user), bypassing the controller's class-level `@Roles(ADMIN)` and
 * nest-server's `checkRoles` guard. The forged `roles:['admin']` was then written to the
 * caller's own users row and became authoritative for `@Restricted(RoleEnum.ADMIN)`.
 *
 * Fix: server-managed core fields (`roles`, `verified`, `verifiedAt`, `twoFactorEnabled`,
 * `termsAndPrivacyAcceptedAt`, `iamId`) are registered with `input: false`, so Better-Auth's
 * native input parsing rejects client-supplied values: it throws `FIELD_NOT_ALLOWED` (HTTP 400)
 * on the update-user route and substitutes the server default on sign-up create.
 *
 * These tests assert (the DB-state assertion is the load-bearing one):
 *  - a non-admin's `POST /iam/update-user {"roles":["admin"]}` is rejected (or ignored) AND the
 *    user's `roles` stay `[]` / `hasRole('admin')` is false;
 *  - the same protection holds for `verified` (email-verification bypass);
 *  - a legitimate update via update-user (e.g. `name`) still works (proves the 400 is
 *    specifically the field lock, not a broken/unauthenticated request);
 *  - the normal nest-server role-assignment path (UserService, Mongoose writes + `checkRoles`)
 *    STILL works — the fix does not over-restrict server-side role assignment.
 *
 * Prerequisites: Better-Auth must be enabled for these tests to run.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { Db, MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreBetterAuthService, HttpExceptionLogFilter, RoleEnum, TestHelper } from '../../src';
import envConfig from '../../src/config.env';
import { ServerModule } from '../../src/server/server.module';
import { UserService } from '../../src/server/modules/user/user.service';

describe('Story: Better-Auth Privilege-Escalation Prevention', () => {
  // Test environment
  let app;
  let testHelper: TestHelper;
  let mongoClient: MongoClient;
  let db: Db;
  let betterAuthService: CoreBetterAuthService;
  let userService: UserService;
  let isBetterAuthEnabled: boolean;

  // Test data tracking for cleanup
  const testEmails: string[] = [];

  // Helper to generate unique test emails
  const generateTestEmail = (prefix: string): string => {
    const email = `privesc-${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
    testEmails.push(email);
    return email;
  };

  /**
   * Sign up a plain non-admin user (default `roles: []`), sign in, and return the identifiers
   * needed to drive an authenticated update-user request.
   *
   * update-user runs under Better-Auth's native sessionMiddleware. We authenticate with the JWT
   * returned from sign-in: the API middleware resolves it to the DB session (via
   * CoreBetterAuthMiddleware) and re-signs it as a session cookie for Better-Auth's native handler.
   */
  async function createSignedInUser(prefix: string): Promise<{ email: string; token: string; userId: string }> {
    const email = generateTestEmail(prefix);
    const password = 'PrivEscTest123!';

    await testHelper.rest('/iam/sign-up/email', {
      method: 'POST',
      payload: { email, name: 'PrivEsc User', password, termsAndPrivacyAccepted: true },
      statusCode: 201,
    });

    // ENV PRECONDITION: this sign-in assumes `betterAuth.emailVerification` is disabled, which is
    // the case for the e2e/ci/development configs — this suite's designated runner is NODE_ENV=e2e
    // (via `pnpm test`). We deliberately do NOT pre-verify the user in the DB to force env-
    // independence: setting `emailVerified` here would be synced to the nest-server `verified` field
    // by the user mapper on sign-in, which would invalidate the `verified` email-verification-bypass
    // assertion further down. Running this file under the `local` config (e.g. a bare
    // `npx vitest run --config vitest-e2e.config.ts <file>` WITHOUT NODE_ENV=e2e) will therefore
    // fail sign-in with 401 EMAIL_VERIFICATION_REQUIRED — that is a wrong-runner symptom, not a bug.
    // The guard `it('has Better-Auth enabled …')` plus this note make the requirement explicit.
    const signIn = await testHelper.rest('/iam/sign-in/email', {
      method: 'POST',
      payload: { email, password },
      statusCode: 200,
    });

    const dbUser = await db.collection('users').findOne({ email });
    return { email, token: signIn?.token || '', userId: dbUser?._id?.toString() || '' };
  }

  // ===================================================================================================================
  // Setup and Teardown
  // ===================================================================================================================

  beforeAll(async () => {
    try {
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [ServerModule],
        providers: [UserService, { provide: 'PUB_SUB', useValue: new PubSub() }],
      }).compile();

      app = moduleFixture.createNestApplication();
      app.useGlobalFilters(new HttpExceptionLogFilter());
      app.setBaseViewsDir(envConfig.templates.path);
      app.setViewEngine(envConfig.templates.engine);
      await app.init();
      testHelper = new TestHelper(app);

      betterAuthService = moduleFixture.get(CoreBetterAuthService);
      userService = moduleFixture.get(UserService);
      isBetterAuthEnabled = betterAuthService.isEnabled();

      mongoClient = await MongoClient.connect(envConfig.mongoose.uri);
      db = mongoClient.db();
    } catch (e) {
      console.error('beforeAllError', e);
      throw e;
    }
  });

  afterAll(async () => {
    if (db) {
      for (const email of testEmails) {
        const user = await db.collection('users').findOne({ email });
        if (user) {
          const userIds: any[] = [user._id, user._id.toString()];
          if (user.iamId) {
            userIds.push(user.iamId);
          }
          await db.collection('users').deleteOne({ _id: user._id });
          await db.collection('account').deleteMany({ userId: { $in: userIds } });
          await db.collection('session').deleteMany({ userId: { $in: userIds } });
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
  // Guard: Better-Auth must be enabled for this regression suite to be meaningful
  // ===================================================================================================================

  it('has Better-Auth enabled (otherwise this regression suite is meaningless)', () => {
    expect(isBetterAuthEnabled).toBe(true);
  });

  // ===================================================================================================================
  // The core vulnerability: self-service privilege escalation via update-user
  // ===================================================================================================================

  describe('POST /iam/update-user cannot self-set `roles`', () => {
    it('SECURITY: rejects {"roles":["admin"]} from a non-admin AND leaves roles unchanged', async () => {
      const { email, token, userId } = await createSignedInUser('roles-attack');
      expect(token).not.toBe('');

      // Sanity: the freshly registered user starts with no roles.
      const before = await db.collection('users').findOne({ email });
      expect(before?.roles ?? []).toEqual([]);

      // The attack: forge admin via the raw-forwarded Better-Auth update-user route.
      // With `input: false` on `roles`, Better-Auth's native handler throws FIELD_NOT_ALLOWED (400).
      const attack = await testHelper.rest('/iam/update-user', {
        method: 'POST',
        payload: { roles: ['admin'] },
        statusCode: 400,
        token,
      });

      // Response shape (secondary): Better-Auth's native FIELD_NOT_ALLOWED error.
      expect(attack?.code).toBe('FIELD_NOT_ALLOWED');

      // LOAD-BEARING assertion: regardless of the response shape, the user must NOT have become admin.
      const after = await db.collection('users').findOne({ email });
      expect(after?.roles ?? []).toEqual([]);
      expect((after?.roles ?? []).includes('admin')).toBe(false);

      // And the resolver-level role check must agree.
      const model = await userService.getViaEmail(email);
      expect(model.hasRole(RoleEnum.ADMIN)).toBe(false);

      void userId;
    });

    it('SECURITY: rejects {"verified":true} from a non-admin AND leaves verified false (email-verification bypass)', async () => {
      const { email, token } = await createSignedInUser('verified-attack');
      expect(token).not.toBe('');

      const attack = await testHelper.rest('/iam/update-user', {
        method: 'POST',
        payload: { verified: true },
        statusCode: 400,
        token,
      });

      expect(attack?.code).toBe('FIELD_NOT_ALLOWED');

      // LOAD-BEARING assertion: the user must NOT have self-verified.
      const after = await db.collection('users').findOne({ email });
      expect(after?.verified === true).toBe(false);
    });

    it('SECURITY: sign-up create body cannot self-set `roles` (server default substituted, not persisted)', async () => {
      // The OTHER half of the fix: the create path. Unlike update-user (which throws 400),
      // Better-Auth's create path with `input: false` silently substitutes the server default,
      // and the controller-handled sign-up additionally whitelists `roles` out of the DTO — so a
      // forged `roles:['admin']` in the sign-up body is dropped and the account is created with [].
      const email = generateTestEmail('signup-roles-attack');
      const password = 'PrivEscTest123!';

      await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'Attacker', password, roles: ['admin'], termsAndPrivacyAccepted: true },
        statusCode: 201,
      });

      // LOAD-BEARING: the forged role must not have been persisted on the new account.
      const after = await db.collection('users').findOne({ email });
      expect(after?.roles ?? []).toEqual([]);
      expect((after?.roles ?? []).includes('admin')).toBe(false);

      const model = await userService.getViaEmail(email);
      expect(model.hasRole(RoleEnum.ADMIN)).toBe(false);
    });

    it('CONTROL: a legitimate update-user field (name) still succeeds (proves the 400 is the field lock, not auth)', async () => {
      const { email, token } = await createSignedInUser('legit-update');
      expect(token).not.toBe('');

      const result = await testHelper.rest('/iam/update-user', {
        method: 'POST',
        payload: { name: 'Renamed User' },
        statusCode: 200,
        token,
      });

      expect(result?.status).toBe(true);

      const after = await db.collection('users').findOne({ email });
      expect(after?.name).toBe('Renamed User');
      // The legitimate update must not have granted any roles either.
      expect(after?.roles ?? []).toEqual([]);
    });
  });

  // ===================================================================================================================
  // Positive: the fix must NOT break legitimate server-side role assignment
  // ===================================================================================================================

  // API-first note: the SECURITY assertions above deliberately go through the real REST endpoints
  // (/iam/update-user, /iam/sign-up/email). The POSITIVE cases below call UserService directly on
  // purpose — their whole point is to isolate and prove the nest-server *service-layer* write path
  // (setRoles / CrudService.update via `checkRoles` + Mongoose `$set`) is NOT gated by Better-Auth's
  // `input: false`. Routing them through a GraphQL/REST admin endpoint would conflate the two layers
  // and defeat that isolation, so the direct call is intentional here, not an API-first violation.
  describe('nest-server role assignment is unaffected by input:false', () => {
    it('POSITIVE: UserService.setRoles assigns roles via the Mongoose write path (no Better-Auth input parsing)', async () => {
      const { email, userId } = await createSignedInUser('setroles');
      expect(userId).not.toBe('');

      await userService.setRoles(userId, [RoleEnum.ADMIN]);

      const after = await db.collection('users').findOne({ email });
      expect(after?.roles).toEqual([RoleEnum.ADMIN]);

      const model = await userService.getViaEmail(email);
      expect(model.hasRole(RoleEnum.ADMIN)).toBe(true);
    });

    it('POSITIVE: admin-driven UserService.update sets roles through CrudService checkRoles + Mongoose', async () => {
      // An admin actor whose model resolves hasRole(ADMIN) === true.
      const admin = await createSignedInUser('admin-actor');
      await userService.setRoles(admin.userId, [RoleEnum.ADMIN]);
      const adminModel = await userService.getViaEmail(admin.email);
      expect(adminModel.hasRole(RoleEnum.ADMIN)).toBe(true);

      // The target the admin promotes.
      const target = await createSignedInUser('promote-target');
      expect((await db.collection('users').findOne({ email: target.email }))?.roles ?? []).toEqual([]);

      await userService.update(target.userId, { roles: [RoleEnum.ADMIN] } as any, { currentUser: adminModel as any });

      const after = await db.collection('users').findOne({ email: target.email });
      expect(after?.roles).toEqual([RoleEnum.ADMIN]);
    });
  });
});
