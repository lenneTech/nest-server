import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createBetterAuthInstance,
  wsSessionRevocationPlugin,
} from '../../src/core/modules/better-auth/better-auth.config';
import {
  cachedJwtSession,
  clearJwtSessionCache,
  JWT_SESSION_CACHE_MAX,
  rememberJwtSession,
  setJwtSessionBroadcaster,
} from '../../src/core/modules/better-auth/core-better-auth-jwt-session.cache';
import { CoreBetterAuthUserMapper } from '../../src/core/modules/better-auth/core-better-auth-user.mapper';
import { CoreBetterAuthService } from '../../src/core/modules/better-auth/core-better-auth.service';

/**
 * A Better-Auth JWT is bound to the session it was issued from (DEV-4309, 12.11.0). Before, the API checked its
 * signature and expiry only: after `POST /iam/sign-out`, a revoked session or a deleted user the JWT kept reading and
 * writing for the rest of its lifetime (measured: 14 min 57 s of 15), and so did a copy of it.
 */

const SECRET = 'a-very-long-secret-that-is-at-least-32-characters-long-for-testing';
const USER = '64b7f0c2a1b2c3d4e5f60718';
const OTHER_USER = '64b7f0c2a1b2c3d4e5f60799';

/** Minimal MongoDB `Db` stand-in for createBetterAuthInstance(). */
const fakeDb: any = {
  collection: () => ({
    aggregate: () => ({ toArray: async () => [] }),
    createIndex: async () => undefined,
    find: () => {
      const cursor: any = { limit: () => cursor, skip: () => cursor, sort: () => cursor, toArray: async () => [] };
      return cursor;
    },
    findOne: async () => null,
    insertOne: async () => ({ insertedId: 'x' }),
  }),
};

interface StoredSession {
  expiresAt: Date;
  id: string;
  token: string;
  userId: string;
}

/** A CoreBetterAuthService over a fake Better-Auth context whose adapter holds `sessions`. */
function serviceOver(sessions: Map<string, StoredSession>) {
  const findOne = vi.fn(async ({ where }: any) => sessions.get(where[0]?.value) ?? null);
  const service = new CoreBetterAuthService(
    {
      $context: Promise.resolve({
        adapter: { findOne },
        internalAdapter: {
          findUserById: async (id: string) => ({ email: 'jwt@test.com', emailVerified: true, id, name: 'JWT' }),
        },
        options: {},
      }),
      options: {},
    } as any,
    null as any,
    { jwt: true, secret: SECRET } as any,
  );
  return { findOne, service };
}

/** An HS256 JWT as the API verifies it, for `sub` and with `sid` unless it is `null`. */
async function jwtFor(sub: string, sid: null | string): Promise<string> {
  return new SignJWT(sid === null ? {} : { sid })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(SECRET));
}

function liveSession(id: string, userId = USER): StoredSession {
  return { expiresAt: new Date(Date.now() + 60_000), id, token: `token-of-${id}`, userId };
}

beforeEach(() => clearJwtSessionCache());
afterEach(() => setJwtSessionBroadcaster(undefined));

describe('Better-Auth JWT: bound to its session', () => {
  /**
   * @regression   12.11.0 — verifyJwtToken() accepted a JWT on its signature and expiry alone: after a sign-out it kept
   *   working until it expired (15 minutes by default).
   * @seen-failing Return the payload without the session check in verifyJwtToken()
   *   (src/core/modules/better-auth/core-better-auth.service.ts) — registered as mutation `jwt-session-not-checked` in
   *   tests/regression-mutations.json.
   */
  it('accepts a JWT only while its session lives and belongs to its subject', async () => {
    const sessions = new Map([['session-a', liveSession('session-a')]]);
    const { service } = serviceOver(sessions);

    expect(await service.verifyJwtToken(await jwtFor(USER, 'session-a'))).toMatchObject({
      sid: 'session-a',
      sub: USER,
    });
    // Unknown session, a session of another user, an expired session, no session reference at all
    expect(await service.verifyJwtToken(await jwtFor(USER, 'session-gone'))).toBeNull();
    sessions.set('session-b', liveSession('session-b', OTHER_USER));
    expect(await service.verifyJwtToken(await jwtFor(USER, 'session-b'))).toBeNull();
    sessions.set('session-c', { ...liveSession('session-c'), expiresAt: new Date(Date.now() - 1000) });
    expect(await service.verifyJwtToken(await jwtFor(USER, 'session-c'))).toBeNull();
    expect(await service.verifyJwtToken(await jwtFor(USER, null))).toBeNull();
  });

  /**
   * @regression   12.11.0 — the same defect, through the deletion: a session Better-Auth deletes must stop its JWTs at
   *   once, not when the cached answer expires.
   * @seen-failing Drop the jwtSessionEnded() call from wsSessionRevocationPlugin()
   *   (src/core/modules/better-auth/better-auth.config.ts) — registered as mutation `jwt-session-deletion-kept` in
   *   tests/regression-mutations.json.
   */
  it('refuses a JWT at once when Better-Auth deletes its session, cached answer or not', async () => {
    const sessions = new Map([['session-a', liveSession('session-a')]]);
    const { findOne, service } = serviceOver(sessions);
    const jwt = await jwtFor(USER, 'session-a');

    expect(await service.verifyJwtToken(jwt)).not.toBeNull();
    expect(await service.verifyJwtToken(jwt)).not.toBeNull();
    expect(findOne, 'the second request is answered from the cache').toHaveBeenCalledTimes(1);

    // Sign-out: Better-Auth deletes the session and runs the delete hooks of its plugins
    sessions.delete('session-a');
    const hooks = (wsSessionRevocationPlugin() as any).init().options.databaseHooks;
    await hooks.session.delete.after({ id: 'session-a', userId: USER });

    expect(await service.verifyJwtToken(jwt)).toBeNull();
  });

  it('asks again once the cached answer expires — what no deletion hook reports', async () => {
    const sessions = new Map([['session-a', liveSession('session-a')]]);
    const { service } = serviceOver(sessions);
    (service as any).jwtSessionCacheTtlMs = 20;
    const jwt = await jwtFor(USER, 'session-a');

    expect(await service.verifyJwtToken(jwt)).not.toBeNull();
    sessions.delete('session-a'); // removed in the database, no hook ran
    expect(await service.verifyJwtToken(jwt), 'within the interval the answer stands').not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await service.verifyJwtToken(jwt)).toBeNull();
  });

  /**
   * @regression   12.11.0 — the middleware handed Better-Auth's plugin routes the user's NEWEST session for a JWT
   *   request; getJwtSession() resolves the JWT's own session instead, and only one of the JWT's subject.
   * @seen-failing Drop the user check from getJwtSession() (src/core/modules/better-auth/core-better-auth.service.ts) —
   *   registered as mutation `jwt-session-of-other-user` in tests/regression-mutations.json.
   */
  it('resolves a JWT to its own session, never to another session of its user', async () => {
    const sessions = new Map([
      ['session-old', liveSession('session-old')],
      ['session-new', liveSession('session-new')],
      ['session-foreign', liveSession('session-foreign', OTHER_USER)],
    ]);
    const { service } = serviceOver(sessions);

    const own = await service.getJwtSession({ sid: 'session-old', sub: USER });
    expect(own.session).toMatchObject({ id: 'session-old', token: 'token-of-session-old', userId: USER });
    expect(own.user).toMatchObject({ id: USER });
    expect((await service.getJwtSession({ sid: 'session-foreign', sub: USER })).session).toBeNull();
    expect((await service.getJwtSession({ sub: USER })).session).toBeNull();
  });

  /**
   * @regression   12.11.0 — a JWT carried no reference to its session, so nothing could bind it.
   * @seen-failing Drop `sid` from the payload in buildPlugins() (src/core/modules/better-auth/better-auth.config.ts) —
   *   registered as mutation `jwt-payload-without-session-id` in tests/regression-mutations.json.
   */
  it('issues the JWT with the id of its session, next to the session user', async () => {
    const result = createBetterAuthInstance({
      config: { enabled: true, jwt: true, secret: SECRET } as any,
      db: fakeDb,
    } as any);
    const context = await result!.instance.$context;
    const jwtPlugin = context.options.plugins.find((plugin: any) => plugin.id === 'jwt');
    const payload = await jwtPlugin.options.jwt.definePayload({
      session: { id: 'session-a', userId: USER },
      user: { email: 'jwt@test.com', id: USER },
    });
    expect(payload).toEqual({ email: 'jwt@test.com', id: USER, sid: 'session-a' });
  });
});

describe('JWT session cache', () => {
  /**
   * @regression   12.11.0 — a cached answer for one user must never vouch for a JWT of another user naming the same
   *   session.
   * @seen-failing Ignore the user of the cached entry in cachedJwtSession()
   *   (src/core/modules/better-auth/core-better-auth-jwt-session.cache.ts) — registered as mutation
   *   `jwt-session-cache-ignores-user` in tests/regression-mutations.json.
   */
  it('answers only for the user it was asked for, and only until its time', () => {
    const now = Date.now();
    rememberJwtSession('session-a', USER, true, now + 1000);
    expect(cachedJwtSession('session-a', USER, now)).toBe(true);
    expect(cachedJwtSession('session-a', OTHER_USER, now)).toBe(false);
    expect(cachedJwtSession('session-a', USER, now + 1000)).toBeUndefined();
  });

  it('holds at most JWT_SESSION_CACHE_MAX sessions, evicting the oldest', () => {
    const until = Date.now() + 60_000;
    for (let i = 0; i <= JWT_SESSION_CACHE_MAX; i++) {
      rememberJwtSession(`session-${i}`, USER, true, until);
    }
    expect(cachedJwtSession('session-0', USER)).toBeUndefined();
    expect(cachedJwtSession(`session-${JWT_SESSION_CACHE_MAX}`, USER)).toBe(true);
  });

  it('tells the other replicas about an ended session, and forgets one they report', () => {
    const broadcast = vi.fn();
    setJwtSessionBroadcaster(broadcast);
    rememberJwtSession('session-a', USER, true, Date.now() + 60_000);
    const hooks = (wsSessionRevocationPlugin() as any).init().options.databaseHooks;
    void hooks.session.delete.after({ id: 'session-a', userId: USER });
    expect(broadcast).toHaveBeenCalledWith('session-a');

    // Received over the user mapper's invalidation channel from another replica
    rememberJwtSession('session-b', USER, true, Date.now() + 60_000);
    (new CoreBetterAuthUserMapper() as any).applyInvalidation(JSON.stringify({ sessionId: 'session-b' }));
    expect(cachedJwtSession('session-b', USER)).toBeUndefined();
  });
});
