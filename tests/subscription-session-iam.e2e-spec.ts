import { INestApplication, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { Client, createClient } from 'graphql-ws';
import { Db, MongoClient } from 'mongodb';
import ws = require('ws');
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { CoreBetterAuthModule, CoreModule, TestHelper } from '../src';
import envConfig from '../src/config.env';
import { Any } from '../src/core/common/scalars/any.scalar';
import { DateScalar } from '../src/core/common/scalars/date.scalar';
import { JSON as JSONScalar } from '../src/core/common/scalars/json.scalar';

/**
 * The IAM WebSocket handshake and session lifecycle, on the assembled `CoreModule` — IAM-only, the
 * one-argument `CoreModule.forRoot(config)` every project generated from the starter uses.
 *
 * `tests/subscription-revalidation.e2e-spec.ts` drives the re-check mechanism over a bare app. This
 * file proves the parts only the real stack has: that `CoreModule`'s `onConnect` accepts a bearer
 * token at all, and that signing out reaches an open socket through Better-Auth's session hook.
 *
 * @regression   11.42.3 — the IAM handshake asked `getSession()` with an `authorization` header,
 *   which Better-Auth reads only with its `bearer` plugin. The framework installs none, so every IAM
 *   WebSocket handshake with a valid bearer token was refused as "Invalid or expired session".
 * @seen-failing Make `authenticateIamWsToken()` in src/core.module.ts skip the session-store lookup
 *   (`getSessionByToken()`), so a session token reaches `getSession()` alone — registered as mutation
 *   `iam-ws-handshake-getsession-only` in tests/regression-mutations.json.
 *
 * @regression   11.42.3 — `CoreBetterAuthService.revokeSession()` called Better-Auth's `signOut` with
 *   only an `Authorization` header, which Better-Auth reads only with its `bearer` plugin. IAM sign-out
 *   answered `{ success: true }` and cleared the cookies, and the session stayed valid server-side —
 *   the same token kept authenticating every request until it expired.
 * @seen-failing Drop the signed session cookie from the headers `revokeSession()` passes in
 *   src/core/modules/better-auth/core-better-auth.service.ts — registered as mutation
 *   `iam-revoke-session-header-only` in tests/regression-mutations.json.
 */
describe('IAM WebSocket handshake and session lifecycle (e2e)', () => {
  let app: INestApplication;
  let httpServer: any;
  let testHelper: TestHelper;
  let mongo: MongoClient;
  let db: Db;
  let url: string;
  const emails: string[] = [];
  const clients: Client[] = [];

  const waitUntil = async (condition: () => boolean, label: string, timeoutMs = 8000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for: ${label}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  /** Sign up, verify and sign in through IAM; answers the stored session token. */
  const signIn = async (prefix: string): Promise<string> => {
    const email = `ws-iam-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`;
    const password = 'WsIamSession123!';
    emails.push(email);
    await testHelper.rest('/iam/sign-up/email', {
      method: 'POST',
      payload: { email, name: `WS ${prefix}`, password, termsAndPrivacyAccepted: true },
      statusCode: 201,
    });
    await db.collection('users').updateOne({ email }, { $set: { emailVerified: true, verified: true } });
    await testHelper.rest('/iam/sign-in/email', { method: 'POST', payload: { email, password }, statusCode: 200 });
    const user = await db.collection('users').findOne({ email });
    const sessions = await db
      .collection('session')
      .find({ $or: [{ userId: user?._id }, { userId: String(user?._id) }] })
      .sort({ createdAt: -1 })
      .limit(1)
      .toArray();
    expect(sessions[0]?.token, 'a stored session after sign-in').toBeTruthy();
    return sessions[0].token;
  };

  const connect = (token: string) => {
    const state = { closes: [] as Array<{ code: number; reason: string }>, connected: false };
    const client = createClient({
      connectionParams: { Authorization: `Bearer ${token}` },
      lazy: false,
      on: {
        closed: (event: any) => state.closes.push({ code: event?.code, reason: event?.reason }),
        connected: () => {
          state.connected = true;
        },
      },
      // The asserted outcome is the close itself — see subscription-revalidation.e2e-spec.ts.
      onNonLazyError: () => undefined,
      retryAttempts: 0,
      url,
      webSocketImpl: ws,
    });
    clients.push(client);
    return state;
  };

  beforeAll(async () => {
    CoreBetterAuthModule.reset();
    const testConfig: any = {
      ...envConfig,
      betterAuth: { ...envConfig.betterAuth, emailVerification: false, enabled: true, signUpChecks: false },
    };

    @Module({
      imports: [CoreModule.forRoot(testConfig), ScheduleModule.forRoot()],
      providers: [Any, DateScalar, JSONScalar, { provide: 'PUB_SUB', useValue: new PubSub() }],
    })
    class IamWsTestModule {}

    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [IamWsTestModule] }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    httpServer = app.getHttpServer();
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    url = `ws://127.0.0.1:${httpServer.address().port}/graphql`;
    testHelper = new TestHelper(app, url);
    mongo = await MongoClient.connect(envConfig.mongoose.uri);
    db = mongo.db();
  }, 60_000);

  afterEach(async () => {
    while (clients.length) {
      await clients.pop()!.dispose();
    }
  });

  afterAll(async () => {
    if (db && emails.length) {
      const users = await db.collection('users').find({ email: { $in: emails } }).toArray();
      const ids = users.map((user) => user._id);
      await db.collection('session').deleteMany({ $or: [{ userId: { $in: ids } }, { userId: { $in: ids.map(String) } }] });
      await db.collection('account').deleteMany({ $or: [{ userId: { $in: ids } }, { userId: { $in: ids.map(String) } }] });
      await db.collection('users').deleteMany({ email: { $in: emails } });
    }
    await mongo?.close();
    if (httpServer) {
      httpServer.closeAllConnections?.();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    await app?.close();
    CoreBetterAuthModule.reset();
  });

  it('accepts a handshake carrying a valid bearer session token', async () => {
    const token = await signIn('accept');
    const socket = connect(token);
    await waitUntil(() => socket.connected || socket.closes.length > 0, 'handshake answered');
    expect(socket.closes, 'the handshake was refused').toEqual([]);
    expect(socket.connected).toBe(true);
  });

  it('refuses a handshake whose token belongs to no session', async () => {
    const socket = connect('not-a-session-token-at-all');
    await waitUntil(() => socket.connected || socket.closes.length > 0, 'handshake answered');
    expect(socket.connected).toBe(false);
    expect(socket.closes[0].code).not.toBe(1000);
  });

  it('signs a session out for real: the token no longer authenticates afterwards', async () => {
    const token = await signIn('revoke');
    const before: any = await testHelper.rest('/iam/get-session', { headers: { Authorization: `Bearer ${token}` } });
    expect(before?.session?.token, 'the token authenticates before the sign-out').toBe(token);

    await testHelper.rest('/iam/sign-out', { method: 'POST', statusCode: 201, token });

    expect(await db.collection('session').findOne({ token }), 'session row after the sign-out').toBeNull();
    const after: any = await testHelper.rest('/iam/get-session', { headers: { Authorization: `Bearer ${token}` } });
    expect(after?.session ?? null, 'session for the signed-out token').toBeNull();
  });

  /**
   * @regression   11.42.3 — signing out ended the session for new requests and left a WebSocket opened
   *   with it running until its next re-check, or — before 11.42.3 — until the client reconnected.
   * @seen-failing Build the plugin list in `buildPlugins()` in
   *   src/core/modules/better-auth/better-auth.config.ts without `wsSessionRevocationPlugin()` —
   *   registered as mutation `ws-session-revocation-plugin-missing` in tests/regression-mutations.json.
   */
  it('closes the open socket at once when its session is signed out', async () => {
    const token = await signIn('signout');
    const socket = connect(token);
    await waitUntil(() => socket.connected, 'connected');

    await testHelper.rest('/iam/sign-out', { method: 'POST', statusCode: 201, token });

    // The revalidation interval is the default 30 s here, so only the session hook can close it this
    // fast — that is the property under test.
    await waitUntil(() => socket.closes.length > 0, 'socket closed after the sign-out', 5000);
    expect(socket.closes[0].code).toBe(4403);
  });

  it('keeps a socket open when ANOTHER session of the same user is signed out (control)', async () => {
    const token = await signIn('two-sessions');
    const email = emails[emails.length - 1];
    await testHelper.rest('/iam/sign-in/email', {
      method: 'POST',
      payload: { email, password: 'WsIamSession123!' },
      statusCode: 200,
    });
    const user = await db.collection('users').findOne({ email });
    const other = await db
      .collection('session')
      .findOne({ $and: [{ $or: [{ userId: user?._id }, { userId: String(user?._id) }] }, { token: { $ne: token } }] });
    expect(other?.token, 'a second session').toBeTruthy();

    const socket = connect(token);
    await waitUntil(() => socket.connected, 'connected');
    await testHelper.rest('/iam/sign-out', { method: 'POST', statusCode: 201, token: other!.token });
    expect(await db.collection('session').findOne({ token: other!.token }), 'the other session was signed out').toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(socket.closes).toEqual([]);
  });
});
