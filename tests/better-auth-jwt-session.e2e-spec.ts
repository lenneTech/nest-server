/**
 * Better-Auth JWT bound to its session, against the assembled server (DEV-4309, 12.11.0).
 *
 * Before 12.11.0 the API accepted a Better-Auth JWT on its signature and expiry alone: after `POST /iam/sign-out` the
 * session cookie answered 401 at once, while the JWT kept reading and writing for 14 min 57 s of its 15 — and so did a
 * copy of it. And the middleware handed Better-Auth the user's NEWEST session for a JWT request, so a sign-out with one
 * device's JWT ended the device that signed in last.
 *
 * 12.11.1: turning two-factor off replaces the session; the answer carries the JWT of the new one, or the client's JWT
 * names a deleted session and, without a session cookie, the client has no way to another.
 */
import { Test } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import * as OTPAuth from 'otpauth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import envConfig from '../src/config.env';
import { isJwtShaped } from '../src/core/modules/better-auth/core-better-auth-token.helper';
import { type IamTestDb, openIamTestDb } from './helpers/iam-test-db';

describe('Better-Auth JWT: bound to its session (e2e)', () => {
  let app: any;
  let iamDb: IamTestDb;
  const email = `jwt-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`;
  const password = 'Jwt-Session-Bound-1';
  let userId: string;
  let jwtA: string;
  let jwtB: string;

  /** What a JWT client gets for its own user record. */
  const readOwnUser = (jwt: string) =>
    request(app.getHttpServer()).get(`/users/${userId}`).set('Authorization', `Bearer ${jwt}`);

  beforeAll(async () => {
    // JWT mode: the sign-in answers with a JWT in the body. Set BEFORE the server module is imported, because
    // CoreModule.forRoot() reads the configuration when the module is evaluated.
    (envConfig as any).cookies = false;

    const { ServerModule } = await import('../src/server/server.module');
    const moduleFixture = await Test.createTestingModule({
      imports: [ServerModule],
      providers: [{ provide: 'PUB_SUB', useValue: new PubSub() }],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    iamDb = await openIamTestDb(envConfig.mongoose.uri);

    const signUp = await request(app.getHttpServer())
      .post('/iam/sign-up/email')
      .send({ email, name: 'JWT Session', password, termsAndPrivacyAccepted: true });
    expect(signUp.status, JSON.stringify(signUp.body)).toBe(201);

    // Two sign-ins: two sessions, one JWT each — device A first, device B last
    const signIn = async () => {
      const res = await request(app.getHttpServer()).post('/iam/sign-in/email').send({ email, password });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(isJwtShaped(res.body?.token), 'JWT mode hands out a JWT').toBe(true);
      userId = res.body.user?.id;
      return res.body.token as string;
    };
    jwtA = await signIn();
    jwtB = await signIn();
    expect(userId).toBeTruthy();
  });

  afterAll(async () => {
    if (iamDb) {
      await iamDb.deleteUsers({ email });
      await iamDb.close();
    }
    await app?.close();
  });

  /**
   * @regression   12.11.0 — a JWT stayed valid until its expiry after `POST /iam/sign-out`; a JWT client's sign-out
   *   ended no session at all (it read the cookie alone), and the middleware resolved device A's JWT to device B's
   *   session, the user's newest.
   * @seen-failing Hand Better-Auth the user's newest session for a Bearer JWT again in CoreBetterAuthMiddleware
   *   (src/core/modules/better-auth/core-better-auth.middleware.ts), or read the sign-out's session from the cookie
   *   alone in CoreBetterAuthController.signOut() — registered as mutations `jwt-middleware-newest-session` and
   *   `jwt-sign-out-reads-cookie-only` in tests/regression-mutations.json.
   */
  it('refuses the JWT of a signed-out session at once and keeps the other session working', async () => {
    expect((await readOwnUser(jwtA)).status).toBe(200);
    expect((await readOwnUser(jwtB)).status).toBe(200);

    const signOut = await request(app.getHttpServer()).post('/iam/sign-out').set('Authorization', `Bearer ${jwtA}`);
    expect(signOut.status, JSON.stringify(signOut.body)).toBeLessThan(300);

    expect((await readOwnUser(jwtA)).status, 'device A signed out: its JWT is refused at once').toBe(401);
    expect((await readOwnUser(jwtB)).status, 'device B is still signed in').toBe(200);
  });

  /**
   * @regression   12.11.1 — `POST /iam/two-factor/disable` creates a session, deletes the request's session and
   *   answered `{ status: true }` without a token. A JWT client then held the JWT of a deleted session (401) and,
   *   without a session cookie, could fetch no other: turning 2FA off signed it out.
   * @seen-failing Never treat a session cookie for another session than the request's as a rotation in
   *   presentSessionTokens() (src/core/modules/better-auth/core-better-auth-session-token.helper.ts), or forward
   *   without the request's session in CoreBetterAuthApiMiddleware
   *   (src/core/modules/better-auth/core-better-auth-api.middleware.ts) — registered as mutations
   *   `disable-2fa-leaves-jwt-client-dead-token` and `api-middleware-drops-request-session-token` in
   *   tests/regression-mutations.json.
   */
  it('hands a JWT client the JWT of the new session when 2FA is turned on and off again', async () => {
    const server = app.getHttpServer();
    const enable = await request(server)
      .post('/iam/two-factor/enable')
      .set('Authorization', `Bearer ${jwtB}`)
      .send({ password });
    expect(enable.status, JSON.stringify(enable.body)).toBe(200);
    const secret = String(enable.body?.totpURI).match(/secret=([A-Z2-7]+)/i)?.[1];
    expect(secret, 'enable answers a TOTP URI with a secret').toBeTruthy();
    const code = new OTPAuth.TOTP({
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret!),
    }).generate();

    // The first verify-totp turns 2FA on and replaces the session (12.7.1 rule)
    const verify = await request(server)
      .post('/iam/two-factor/verify-totp')
      .set('Authorization', `Bearer ${jwtB}`)
      .send({ code });
    expect(verify.status, JSON.stringify(verify.body)).toBe(200);
    const jwtOn = verify.body?.token as string;
    expect(isJwtShaped(jwtOn), 'verify-totp answers with the JWT of the new session').toBe(true);
    expect((await readOwnUser(jwtOn)).status).toBe(200);

    const disable = await request(server)
      .post('/iam/two-factor/disable')
      .set('Authorization', `Bearer ${jwtOn}`)
      .send({ password });
    expect(disable.status, JSON.stringify(disable.body)).toBe(200);
    expect(disable.body?.status).toBe(true);
    const jwtOff = disable.body?.token as string;
    expect(isJwtShaped(jwtOff), 'disable answers with the JWT of the session that replaced the old one').toBe(true);
    expect(jwtOff).not.toBe(jwtOn);

    expect((await readOwnUser(jwtOn)).status, 'the replaced session is gone, and its JWT with it').toBe(401);
    expect((await readOwnUser(jwtOff)).status, 'the client stays signed in with the new JWT').toBe(200);
  });
});
