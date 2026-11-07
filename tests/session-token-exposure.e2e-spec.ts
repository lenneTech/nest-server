/**
 * No answer carries a session token (12.7.0, DEV-4109).
 *
 * 12.6.1 took the session token out of the bodies of the forwarded sign-in routes. `GET /iam/list-sessions` still
 * answered every session of the user WITH its token — the bearer credential of every device the user is signed in
 * on, readable by any script on the page. It now answers the sessions by id, and `POST /iam/revoke-session` takes that
 * id (`{ sessionId }`), resolved among the caller's own sessions.
 *
 * The last case is the general guard: every answer this suite received — sign-up, sign-in, get-session,
 * list-sessions, revoke-session — is searched for every session token the users hold.
 *
 * @regression   12.7.0 (DEV-4109) — list-sessions handed out the token of every session of the user.
 * @seen-failing Leave arrays untouched in presentSessionTokens() in
 *   src/core/modules/better-auth/core-better-auth-session-token.helper.ts — registered as mutation
 *   `list-sessions-hands-out-tokens` in tests/regression-mutations.json.
 * @regression   12.7.0 (DEV-4109) — with ids only, a session can be revoked only by its id.
 * @seen-failing Drop the resolveRevokeSessionId() call from the request handler in
 *   src/core/modules/better-auth/core-better-auth-api.middleware.ts — registered as mutation
 *   `revoke-session-id-not-wired` in tests/regression-mutations.json.
 */
import { Test } from '@nestjs/testing';
import bcrypt from 'bcrypt';
import { PubSub } from 'graphql-subscriptions';
import { sha256 } from 'js-sha256';
import * as OTPAuth from 'otpauth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreBetterAuthService, HttpExceptionLogFilter } from '../src';
import envConfig from '../src/config.env';
import { ServerModule } from '../src/server/server.module';
import { type IamTestDb, openIamTestDb } from './helpers/iam-test-db';

interface SignedIn {
  /** `Cookie` header that authenticates as this session */
  cookie: string;
  /** The raw session token, as the database stores it */
  token: string;
}

describe('Session tokens never reach a body (e2e)', () => {
  let app: any;
  let server: any;
  let cookieName: string;
  let iamDb: IamTestDb;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const emailA = `token-exposure-a-${stamp}@test.com`;
  const emailB = `token-exposure-b-${stamp}@test.com`;
  const emailC = `token-exposure-c-${stamp}@test.com`;
  const emailMigrated = `token-exposure-migrated-${stamp}@test.com`;
  const password = 'Token-Exposure-1';
  /** Every answer body this suite received, for the general guard */
  const bodies: unknown[] = [];
  /** Every session token the users hold */
  const tokens: string[] = [];

  const record = (res: request.Response): request.Response => {
    bodies.push(res.body);
    return res;
  };

  const signUp = async (email: string) =>
    record(
      await request(server)
        .post('/iam/sign-up/email')
        .send({ email, name: 'Token Exposure', password, termsAndPrivacyAccepted: true })
        .expect(201),
    );

  const signIn = async (email: string): Promise<SignedIn> => {
    const res = record(await request(server).post('/iam/sign-in/email').send({ email, password }).expect(200));
    const setCookie = ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .find((header) => header.startsWith(`${cookieName}=`));
    expect(setCookie, 'sign-in sets the session cookie').toBeDefined();
    const value = setCookie!.split(';')[0].slice(cookieName.length + 1);
    const token = decodeURIComponent(value).split('.')[0];
    tokens.push(token);
    return { cookie: `${cookieName}=${value}`, token };
  };

  const listSessions = async (as: SignedIn) =>
    record(await request(server).get('/iam/list-sessions').set('Cookie', as.cookie).expect(200));

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [ServerModule],
      providers: [{ provide: 'PUB_SUB', useValue: new PubSub() }],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new HttpExceptionLogFilter());
    await app.init();
    server = app.getHttpServer();
    cookieName = moduleFixture.get(CoreBetterAuthService).getSessionCookieName();
    iamDb = await openIamTestDb(envConfig.mongoose.uri);

    await signUp(emailA);
    await signUp(emailB);
    await signUp(emailC);
  });

  afterAll(async () => {
    if (iamDb) {
      await iamDb.deleteUsers({ email: emailA });
      await iamDb.deleteUsers({ email: emailB });
      await iamDb.deleteUsers({ email: emailC });
      await iamDb.deleteUsers({ email: emailMigrated });
      await iamDb.close();
    }
    await app?.close();
  });

  it('list-sessions names every session by id and hands out no token', async () => {
    const first = await signIn(emailA);
    const second = await signIn(emailA);

    const res = await listSessions(first);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
    for (const session of res.body) {
      expect(session.id, 'a session is named by its id').toBeTruthy();
      expect(session.token, 'no session token in the list').toBeUndefined();
    }
    expect(JSON.stringify(res.body)).not.toContain(first.token);
    expect(JSON.stringify(res.body)).not.toContain(second.token);
  });

  it('revoke-session with a sessionId ends that session of the caller', async () => {
    const keep = await signIn(emailA);
    const end = await signIn(emailA);
    const ended = await iamDb.findSession(end.token);
    expect(ended?.id, 'the session exists before').toBeTruthy();

    record(
      await request(server)
        .post('/iam/revoke-session')
        .set('Cookie', keep.cookie)
        .send({ sessionId: String(ended!.id) })
        .expect(200),
    );

    expect(await iamDb.findSession(end.token), 'the named session is gone').toBeNull();
    expect(await iamDb.findSession(keep.token), 'the caller keeps its own session').not.toBeNull();
  });

  /**
   * @regression   12.7.2 (DEV-4133) — a user the legacy migration linked (created via `POST /users` or the legacy
   *   sign-up, first IAM sign-in later) carries a stored `id` of its own next to `_id`, and the session lookup prefers
   *   it, while every session references `_id`. The middleware searched the caller's sessions under that stored `id`,
   *   found none, and revoke-session by id ended nothing — answering success all the same.
   * @seen-failing Read only `betterAuthSession.user.id` in resolveRevokeSessionId() in
   *   src/core/modules/better-auth/core-better-auth-api.middleware.ts — registered as mutation
   *   `migrated-user-revoke-by-id-ends-nothing` in tests/regression-mutations.json.
   */
  it('revoke-session with a sessionId ends the session of a user the legacy migration linked', async () => {
    // A user as `POST /users` leaves it: a legacy password, no IAM account yet. The first IAM sign-in migrates it.
    const userId = await iamDb.insertUser({
      email: emailMigrated,
      password: await bcrypt.hash(sha256(password), 10),
      roles: [],
      verified: true,
    });
    const keep = await signIn(emailMigrated);
    const end = await signIn(emailMigrated);
    if (iamDb.driver === 'mongodb') {
      const stored = await iamDb.findUser({ email: emailMigrated });
      expect(stored?.id, 'precondition: the migration wrote an id of its own next to _id').toBeTruthy();
      expect(String(stored?.id), 'precondition: that id is not _id').not.toBe(userId);
    }
    const ended = await iamDb.findSession(end.token);
    expect(ended?.id, 'the session exists before').toBeTruthy();

    record(
      await request(server)
        .post('/iam/revoke-session')
        .set('Cookie', keep.cookie)
        .send({ sessionId: String(ended!.id) })
        .expect(200),
    );

    expect(await iamDb.findSession(end.token), 'the named session is gone').toBeNull();
    expect(await iamDb.findSession(keep.token), 'the caller keeps its own session').not.toBeNull();
  });

  it("revoke-session with another user's session id ends nothing", async () => {
    const attacker = await signIn(emailA);
    const victim = await signIn(emailB);
    const victimSession = await iamDb.findSession(victim.token);

    const res = record(
      await request(server)
        .post('/iam/revoke-session')
        .set('Cookie', attacker.cookie)
        .send({ sessionId: String(victimSession!.id) }),
    );

    expect(res.status).toBeLessThan(500);
    expect(await iamDb.findSession(victim.token), "the other user's session survives").not.toBeNull();
  });

  /**
   * @regression   12.7.1 (DEV-4129) — the first verify-totp while enabling 2FA rotates the session: it sets the new
   *   session's cookie, deletes the old session and answered with the OLD token in the body.
   * @seen-failing Never treat a token next to a newly set session cookie as rotated in presentSessionTokens() in
   *   src/core/modules/better-auth/core-better-auth-session-token.helper.ts — registered as mutation
   *   `enable-2fa-hands-out-replaced-token` in tests/regression-mutations.json.
   */
  it('enabling 2FA rotates the session without handing out the replaced token', async () => {
    const holder = await signIn(emailC);
    const enable = record(
      await request(server).post('/iam/two-factor/enable').set('Cookie', holder.cookie).send({ password }).expect(200),
    );
    const secret = String(enable.body?.totpURI).match(/secret=([A-Z2-7]+)/i)?.[1];
    expect(secret, 'enable answers a TOTP URI with a secret').toBeTruthy();
    const code = new OTPAuth.TOTP({
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret!),
    }).generate();

    const verify = record(
      await request(server).post('/iam/two-factor/verify-totp').set('Cookie', holder.cookie).send({ code }).expect(200),
    );
    const rotated = ([] as string[])
      .concat(verify.headers['set-cookie'] ?? [])
      .find((header) => header.startsWith(`${cookieName}=`));
    if (rotated) {
      tokens.push(decodeURIComponent(rotated.split(';')[0].slice(cookieName.length + 1)).split('.')[0]);
    }

    expect(JSON.stringify(verify.body), 'the replaced session token stays out of the body').not.toContain(holder.token);
  });

  it('no answer this suite received carries a session token (general guard)', async () => {
    const holder = await signIn(emailB);
    record(await request(server).get('/iam/get-session').set('Cookie', holder.cookie).expect(200));
    await listSessions(holder);

    expect(tokens.length).toBeGreaterThan(0);
    const all = JSON.stringify(bodies);
    for (const token of tokens) {
      expect(all.includes(token), `session token ${token.slice(0, 6)}… must not appear in any body`).toBe(false);
    }
  });
});
