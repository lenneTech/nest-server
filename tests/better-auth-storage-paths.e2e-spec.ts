/**
 * The framework's own reads and writes of Better-Auth's data, on the database the users live in (DEV-3831).
 *
 * Better-Auth runs on MongoDB in the `e2e` project and on PostgreSQL in the `postgres` and `iam-sql-<engine>` projects. Next to
 * Better-Auth's own handler, the framework reaches that data itself on four paths, and each of them used to read
 * MongoDB directly:
 *
 * - a session token sent as a bearer token to a NestJS route (the middleware looks the session up by its token),
 * - the token service, which the role guard asks when no middleware identified the caller,
 * - the passkey challenge mappings that let a client without cookies finish a WebAuthn ceremony,
 * - the hook that marks the user verified once Better-Auth confirmed the e-mail address.
 *
 * On PostgreSQL a path still reading MongoDB finds nobody there and answers as if the session, the user or the
 * challenge did not exist — or writes where nobody reads. The other IAM suites pass either way: their requests carry
 * a JWT the middleware maps itself, and e2e runs with e-mail verification switched off.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';

import {
  BetterAuthTokenService,
  CoreBetterAuthModule,
  CoreBetterAuthService,
  HttpExceptionLogFilter,
  TestHelper,
} from '../src';
import envConfig from '../src/config.env';
import { CoreAiMcpOAuthService } from '../src/core/modules/ai/services/core-ai-mcp-oauth.service';
import { CoreBetterAuthChallengeService } from '../src/core/modules/better-auth/core-better-auth-challenge.service';
import { getBetterAuthSqlStore } from '../src/core/modules/better-auth/core-better-auth-sql.registry';
import { ServerModule } from '../src/server/server.module';
import { type IamTestDb, openIamTestDb } from './helpers/iam-test-db';

/** The hook Better-Auth calls after a confirmed e-mail address, as the module hands it over */
class EmailVerifiedHook extends CoreBetterAuthModule {
  static run(userId: string): Promise<void> {
    return this.createEmailVerificationCallbacks().onEmailVerified(userId);
  }
}

describe('Better-Auth data on the configured database: session, token, passkey challenge, verified mail', () => {
  let app: any;
  let testHelper: TestHelper;
  let iamDb: IamTestDb;
  const userIds: string[] = [];
  const password = 'StoragePaths123!';

  /** A signed-up and signed-in user: its id, the JWT of the sign-in and the token of its newest session */
  const signUp = async (): Promise<{ email: string; id: string; jwt: string; sessionToken: string }> => {
    const email = `storage-paths-${Date.now()}-${Math.random().toString(36).substring(7)}@test.com`;
    const signedUp: any = await testHelper.rest('/iam/sign-up/email', {
      method: 'POST',
      payload: { email, name: 'Storage Paths', password, termsAndPrivacyAccepted: true },
      statusCode: 201,
    });
    userIds.push(signedUp.user.id);
    const signedIn: any = await testHelper.rest('/iam/sign-in/email', {
      method: 'POST',
      payload: { email, password },
      statusCode: 200,
    });
    const sessionToken = await iamDb.latestSessionToken(signedUp.user.id);
    expect(sessionToken).toBeTruthy();
    expect(signedIn.token?.split('.')).toHaveLength(3);
    return { email, id: signedUp.user.id, jwt: signedIn.token, sessionToken: sessionToken! };
  };

  beforeAll(async () => {
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
    iamDb = await openIamTestDb(envConfig.mongoose.uri);
  });

  afterAll(async () => {
    if (iamDb) {
      await iamDb.deleteUsers({ ids: userIds });
      await iamDb.close();
    }
    if (app) {
      await app.close();
    }
  });

  /**
   * @regression   DEV-3831 (db-agnostic phase 3) — the session lookup by token read MongoDB's `session` collection, so on
   *   PostgreSQL a session token sent as a bearer token identified nobody and every NestJS route answered 401.
   * @seen-failing Drop the SQL branch of CoreBetterAuthService.getSessionByToken() in
   *   src/core/modules/better-auth/core-better-auth.service.ts — registered as mutation `iam-session-lookup-on-mongo`
   *   in tests/regression-mutations.json.
   */
  it('authenticates a session token sent as bearer token on a NestJS route', async () => {
    const user = await signUp();

    const found: any = await testHelper.rest(`/users/${user.id}`, { statusCode: 200, token: user.sessionToken });
    expect(found.id).toBe(user.id);
    expect(found.email).toBe(user.email);

    // The route is not open: a token no session carries identifies nobody
    await testHelper.rest(`/users/${user.id}`, { statusCode: 401, token: 'u'.repeat(32) });
  });

  /**
   * @regression   DEV-3831 (db-agnostic phase 3) — the token service loaded the user of a JWT or a session from
   *   MongoDB's `users` collection, so on PostgreSQL it found nobody and the role guard refused every caller the
   *   middleware had not identified.
   * @seen-failing Let BetterAuthTokenService.users() ignore the SQL store in
   *   src/core/modules/better-auth/better-auth-token.service.ts — registered as mutation `iam-token-user-on-mongo` in
   *   tests/regression-mutations.json.
   */
  it('loads the user of a JWT and of a session token through the token service', async () => {
    const user = await signUp();
    const tokenService = app.get(BetterAuthTokenService);

    for (const token of [user.jwt, user.sessionToken]) {
      const loaded = await tokenService.verifyAndLoadUser(token);
      expect(loaded?.id).toBe(user.id);
      expect(loaded?.email).toBe(user.email);
      expect(loaded?.hasRole(['admin'])).toBe(false);
    }
    expect(await tokenService.verifyAndLoadUser('u'.repeat(32))).toBeNull();
  });

  /**
   * @regression   DEV-3831 (db-agnostic phase 3) — passkey challenge mappings went into MongoDB's
   *   `webauthn_challenge_mappings` while Better-Auth kept the challenge itself on PostgreSQL: half of one ceremony in
   *   each database. Found on the way, on every database: the middleware looked for the challenge cookie as
   *   `better-auth.better-auth-passkey`, while Better-Auth names it after its cookie prefix (`iam.better-auth-passkey`)
   *   — no mapping was ever stored and no `challengeId` returned, so a client without cookies could not finish a
   *   passkey ceremony.
   * @seen-failing Store the mapping in the MongoDB collection whenever it exists, in
   *   CoreBetterAuthChallengeService.storeChallengeMapping() in
   *   src/core/modules/better-auth/core-better-auth-challenge.service.ts, or name the cookie
   *   `better-auth.<key>` again in CoreBetterAuthApiMiddleware.passkeyChallengeCookieName() in
   *   src/core/modules/better-auth/core-better-auth-api.middleware.ts — registered as mutations
   *   `iam-passkey-challenge-on-mongo` and `passkey-challenge-cookie-unprefixed` in tests/regression-mutations.json.
   */
  it('keeps the passkey challenge mapping where Better-Auth keeps its data, until it is used', async () => {
    const user = await signUp();

    const options: any = await testHelper.rest('/iam/passkey/generate-register-options', {
      method: 'GET',
      statusCode: 200,
      token: user.jwt,
    });
    expect(options.challenge).toBeTruthy();
    expect(typeof options.challengeId).toBe('string');

    const stored = await iamDb.passkeyChallenge(options.challengeId);
    expect(stored).toMatchObject({ type: 'registration' });
    expect(stored?.verificationToken).toBeTruthy();
    if (iamDb.driver !== 'mongodb') {
      // Nothing of it in MongoDB
      expect(
        await iamDb.mongo
          .collection('webauthn_challenge_mappings')
          .countDocuments({ challengeId: options.challengeId }),
      ).toBe(0);
    }

    const challenges = app.get(CoreBetterAuthChallengeService, { strict: false });
    expect(await challenges.getVerificationToken(options.challengeId)).toBe(stored?.verificationToken);
    await challenges.deleteChallengeMapping(options.challengeId);
    expect(await challenges.getVerificationToken(options.challengeId)).toBeNull();
    expect(await iamDb.passkeyChallenge(options.challengeId)).toBeNull();
  });

  /**
   * @regression   DEV-3831 (db-agnostic phase 3) — the hook after a confirmed e-mail address set `verified` and
   *   `verifiedAt` in MongoDB's `users` collection, so on PostgreSQL the user stayed unverified for every
   *   `S_VERIFIED` check.
   * @seen-failing Let the module's onEmailVerified callback write to MongoDB whenever a connection exists, in
   *   src/core/modules/better-auth/core-better-auth.module.ts — registered as mutation `iam-email-verified-on-mongo` in
   *   tests/regression-mutations.json.
   */
  /**
   * @regression   DEV-3831 (db-agnostic phase 3) — the MCP OAuth layer loaded an access token's subject from MongoDB's
   *   `users` collection: with the users on PostgreSQL every OAuth-authenticated MCP call found nobody (401), and a
   *   MongoDB copy left over from a migration answered with roles revoked long ago.
   * @seen-failing Skip the SQL branch of CoreAiMcpOAuthService.loadUser() in
   *   src/core/modules/ai/services/core-ai-mcp-oauth.service.ts — registered as mutation `mcp-oauth-user-on-mongo` in
   *   tests/regression-mutations.json.
   */
  it('loads the roles of an MCP OAuth subject from the users table', async () => {
    const user = await signUp();
    await iamDb.updateUser({ id: user.id }, { roles: ['admin'] });
    const oauth = app.get(CoreAiMcpOAuthService, { strict: false });

    expect(await oauth.loadUser(user.id)).toEqual({ id: user.id, roles: ['admin'] });
    // A subject that names no row is nobody
    expect(await oauth.loadUser('0'.repeat(24))).toBeNull();
  });

  it('marks the user verified in the users table once Better-Auth confirmed the e-mail address', async () => {
    const user = await signUp();
    await iamDb.updateUser({ id: user.id }, { verified: false, verifiedAt: null });

    await EmailVerifiedHook.run(user.id);

    const row = await iamDb.findUser({ id: user.id });
    expect(row?.verified).toBe(true);
    expect(row?.verifiedAt).toBeInstanceOf(Date);
  });
  /**
   * @regression   DEV-3832 (db-agnostic phase 4) — Better-Auth never deletes an expired session, and on SQL no TTL index
   *   removes expired verification values (reset links, passkey challenges) either: both tables grew for as long as
   *   the application ran.
   * @seen-failing Keep the sessions in BetterAuthSqlStore.deleteExpired() in
   *   src/core/modules/better-auth/core-better-auth-sql.store.ts — registered as mutation `iam-expired-sessions-kept`
   *   in tests/regression-mutations.json; keep the verification values there — mutation `iam-expired-verification-kept`.
   */
  it('removes expired sessions and verification values on SQL, and only those', async () => {
    const service: any = app.get(CoreBetterAuthService);
    if (iamDb.driver === 'mongodb') {
      // MongoDB removes verification documents through its TTL index; the sweep exists for SQL tables only
      expect(service.expirySweep).toBeUndefined();
      return;
    }
    const user = await signUp();
    await iamDb.expireSession(user.sessionToken);
    await testHelper.rest('/iam/sign-in/email', {
      method: 'POST',
      payload: { email: user.email, password },
      statusCode: 200,
    });
    const liveSession = await iamDb.latestSessionToken(user.id);
    expect(liveSession).not.toBe(user.sessionToken);

    const challenge = (expiresAt: Date) => ({
      expiresAt,
      type: 'authentication' as const,
      userId: user.id,
      verificationToken: 'token',
    });
    const suffix = Math.random().toString(36).slice(2);
    // The live one FIRST: storing a challenge removes the expired ones already there, so an expired challenge stored
    // before it would be gone before the sweep runs, and its assertion would hold whatever the sweep did
    await getBetterAuthSqlStore()!.storeChallenge(`live-${suffix}`, challenge(new Date(Date.now() + 60_000)));
    await getBetterAuthSqlStore()!.storeChallenge(`expired-${suffix}`, challenge(new Date(Date.now() - 60_000)));
    expect(await iamDb.passkeyChallenge(`expired-${suffix}`)).not.toBeNull();

    await service.expirySweep.runNow();

    expect(await iamDb.findSession(user.sessionToken)).toBeNull();
    expect(await iamDb.passkeyChallenge(`expired-${suffix}`)).toBeNull();
    expect(await iamDb.findSession(liveSession!)).not.toBeNull();
    expect(await iamDb.passkeyChallenge(`live-${suffix}`)).not.toBeNull();
  });
});
