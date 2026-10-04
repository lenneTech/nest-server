import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { Client, createClient } from 'graphql-ws';
import { Db, MongoClient, ObjectId } from 'mongodb';
import ws = require('ws');
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { RoleEnum, TestGraphQLType, TestHelper } from '../src';
import envConfig from '../src/config.env';
import { revalidateWsConnectionsOf } from '../src/core/common/helpers/graphql-ws-connection.helper';
import { ServerModule } from '../src/server/server.module';
import { UserService } from '../src/server/modules/user/user.service';

/**
 * A role change reaches the user's OPEN WebSocket — on the legacy driver builder, through the
 * framework's own role-assignment API.
 *
 * `ServerModule` uses the three-argument `CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(…),
 * config)`, so its WebSockets authenticate with legacy JWTs. The connection is opened without any
 * subscription (a non-lazy client keeps it alive on its own): what is under test is the connection's
 * authorization, not a particular subscription.
 *
 * @regression   11.42.3 — a role withdrawn through `CoreUserService.setRoles()` changed nothing for a
 *   WebSocket opened before: every subscription and operation on it kept the old roles until the
 *   client reconnected.
 * @seen-failing Delete the `revalidateWsConnectionsOf({ userId: String(userId) })` call from
 *   `setRoles()` in src/core/modules/user/core-user.service.ts — registered as mutation
 *   `set-roles-skips-ws-revalidation` in tests/regression-mutations.json.
 *
 * @regression   11.42.3 — the legacy WebSocket handshake read the token with `decodeJwt()`, which checks
 *   neither signature nor expiry. Only the payload's `tokenId` had to match the device, so an EXPIRED
 *   token — or a copy of one re-signed with any key — kept opening sockets for as long as the device's
 *   refresh token was not rotated. HTTP refused both through passport-jwt.
 * @seen-failing Make `authenticateLegacyWsToken()` in src/core.module.ts read the payload with
 *   `authService.decodeJwt(authToken)` instead of verifying it — registered as mutation
 *   `legacy-ws-jwt-unverified` in tests/regression-mutations.json.
 */
describe('Role changes reach open WebSockets (legacy builder, e2e)', () => {
  let app: INestApplication;
  let httpServer: any;
  let testHelper: TestHelper;
  let userService: UserService;
  let mongo: MongoClient;
  let db: Db;
  let url: string;
  const userIds: string[] = [];
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

  /** Sign up and sign in through the legacy GraphQL API; answers the user id and its legacy JWT. */
  const signUp = async (prefix: string): Promise<{ id: string; token: string }> => {
    const password = `Pw-${Math.random().toString(36).slice(2, 10)}`;
    const email = `ws-legacy-${prefix}-${Date.now()}-${password}@test.com`;
    const created: any = await testHelper.graphQl({
      arguments: { input: { email, firstName: 'Ws', password } },
      fields: [{ user: ['id'] }],
      name: 'signUp',
      type: TestGraphQLType.MUTATION,
    });
    const id = created.user.id;
    userIds.push(id);
    await db.collection('users').updateOne({ _id: new ObjectId(id) }, { $set: { emailVerified: true, verified: true } });
    const signedIn: any = await testHelper.graphQl({
      arguments: { input: { email, password } },
      fields: ['token'],
      name: 'signIn',
      type: TestGraphQLType.MUTATION,
    });
    expect(signedIn.token, 'a legacy JWT').toMatch(/^eyJ/);
    return { id, token: signedIn.token };
  };

  /** The key legacy access tokens are verified with — the order passport-jwt applies. */
  const legacySecret = () => (envConfig.jwt as any)?.secretOrPrivateKey || (envConfig.jwt as any)?.secret;

  /** Re-sign the claims of a real token — same user, device and tokenId, different signature or lifetime. */
  const resign = (token: string, secret: string, claims: Record<string, unknown> = {}, expiresIn?: number) => {
    const { deviceId, id, tokenId } = new JwtService().decode(token) as any;
    return new JwtService().sign(
      { deviceId, id, tokenId, ...claims },
      expiresIn === undefined ? { secret } : { expiresIn, secret },
    );
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
      onNonLazyError: () => undefined,
      retryAttempts: 0,
      url,
      webSocketImpl: ws,
    });
    clients.push(client);
    return state;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ServerModule],
      providers: [{ provide: 'PUB_SUB', useValue: new PubSub() }],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    httpServer = app.getHttpServer();
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    url = `ws://127.0.0.1:${httpServer.address().port}/graphql`;
    testHelper = new TestHelper(app, url);
    userService = moduleFixture.get(UserService);
    mongo = await MongoClient.connect(envConfig.mongoose.uri);
    db = mongo.db();
  }, 60_000);

  afterEach(async () => {
    while (clients.length) {
      await clients.pop()!.dispose();
    }
  });

  afterAll(async () => {
    if (db && userIds.length) {
      await db.collection('users').deleteMany({ _id: { $in: userIds.map((id) => new ObjectId(id)) } });
    }
    await mongo?.close();
    if (httpServer) {
      httpServer.closeAllConnections?.();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    await app?.close();
  });

  it('closes the open socket at once when the user gains a role through setRoles()', async () => {
    const { id, token } = await signUp('gain');
    const socket = connect(token);
    await waitUntil(() => socket.connected || socket.closes.length > 0, 'handshake answered');
    expect(socket.closes, 'the legacy handshake was refused').toEqual([]);

    await userService.setRoles(id, [RoleEnum.ADMIN], { force: true });

    // Default revalidation interval (30 s): only the invalidation can close it this fast.
    await waitUntil(() => socket.closes.length > 0, 'socket closed after the role change', 5000);
    expect(socket.closes[0].code).toBe(4403);
  });

  it('keeps the socket open when ANOTHER user’s roles change (control)', async () => {
    const watched = await signUp('watched');
    const other = await signUp('other');
    const socket = connect(watched.token);
    await waitUntil(() => socket.connected, 'connected');

    await userService.setRoles(other.id, [RoleEnum.ADMIN], { force: true });
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(socket.closes).toEqual([]);
  });

  it('keeps the socket open when setRoles() writes the roles it already has (control)', async () => {
    const { id, token } = await signUp('same');
    const socket = connect(token);
    await waitUntil(() => socket.connected, 'connected');

    await userService.setRoles(id, [], { force: true });
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(socket.closes).toEqual([]);
  });

  it('refuses a handshake whose token carries the right claims under a foreign signature', async () => {
    const { token } = await signUp('forged');
    const forged = resign(token, 'a-key-the-server-never-used-0123456789', {}, 300);

    const socket = connect(forged);
    await waitUntil(() => socket.connected || socket.closes.length > 0, 'handshake answered');
    expect(socket.connected, 'a re-signed token opened a socket').toBe(false);
  });

  it('refuses a handshake with an expired token', async () => {
    const { token } = await signUp('expired');
    const expired = resign(token, legacySecret(), { exp: Math.floor(Date.now() / 1000) - 60 });

    const socket = connect(expired);
    await waitUntil(() => socket.connected || socket.closes.length > 0, 'handshake answered');
    expect(socket.connected, 'an expired token opened a socket').toBe(false);
  });

  it('accepts the same re-signing with the server key while it is valid (control)', async () => {
    const { token } = await signUp('resigned-valid');
    const socket = connect(resign(token, legacySecret(), {}, 300));
    await waitUntil(() => socket.connected || socket.closes.length > 0, 'handshake answered');
    expect(socket.closes).toEqual([]);
    expect(socket.connected).toBe(true);
  });

  it('closes an open socket once its token has expired', async () => {
    const { id, token } = await signUp('expiring');
    const socket = connect(resign(token, legacySecret(), {}, 2));
    await waitUntil(() => socket.connected, 'connected');

    await new Promise((resolve) => setTimeout(resolve, 2500));
    // The re-check the interval would run on the next event, asked for directly.
    revalidateWsConnectionsOf({ userId: id });

    await waitUntil(() => socket.closes.length > 0, 'socket closed after expiry', 5000);
    expect(socket.closes[0].code).toBe(4403);
  });
});
