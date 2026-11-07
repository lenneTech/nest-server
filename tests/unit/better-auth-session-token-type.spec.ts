/**
 * Unit Tests: a session token is a non-empty string, on the way in and at the query (DEV-4138).
 *
 * cookie-parser turns a cookie value starting with `j:` into the parsed JSON, so `iam.session_token=j:{"$ne":null}`
 * reaches `req.cookies` as an object. The guard fallback (`extractTokenFromRequest()` → `verifyAndLoadUser()`) handed
 * it to `getSessionByToken()`, which put it into a raw `{ $match: { token } }` — MongoDB read it as an operator and
 * answered with the first stored session, so a request without any credential was signed in as somebody else.
 * `{ "$regex": "^a" }` turns the same hole into a search for a live session.
 *
 * Two layers, each pinned on its own: the token service passes only string cookies on, and the session lookup refuses
 * anything else before it queries — the latter because projects call `getSessionByToken()` with cookie values of their
 * own. The lookup runs against a recording fake of the session collection that ANSWERS every query with a live session:
 * a refusal therefore means the value never became a query, not that nothing matched.
 *
 * @regression   DEV-4138 — extractTokenFromRequest() returned non-string cookie values, and getSessionByToken() matched
 *   `{ token: <object> }`, so a `j:{"$ne":null}` cookie authenticated as the owner of a stored session.
 * @seen-failing Restore `request.cookies[cookieName] || request.cookies['token'] || undefined` in
 *   src/core/modules/better-auth/better-auth-token.service.ts — registered as mutation
 *   `session-cookie-object-accepted` in tests/regression-mutations.json; drop `!isQueryableString(token) ||` from
 *   getSessionByToken() in src/core/modules/better-auth/core-better-auth.service.ts — registered as mutation
 *   `session-lookup-object-token-matched`.
 */
import { describe, expect, it, vi } from 'vitest';

import { BetterAuthTokenService } from '../../src/core/modules/better-auth/better-auth-token.service';
import { CoreBetterAuthService } from '../../src/core/modules/better-auth/core-better-auth.service';

const COOKIE = 'iam.session_token';

/** What cookie-parser makes of `j:` cookies a client can send, plus the other non-string shapes a value can take */
const NON_STRING_VALUES: [string, unknown][] = [
  ['an operator object (j:{"$ne":null})', { $ne: null }],
  ['a regex operator (j:{"$regex":"^a"})', { $regex: '^a' }],
  ['an array (j:["a"])', ['a']],
  ['a number (j:1)', 1],
  ['a boolean (j:true)', true],
  ['null (j:null)', null],
  ['an empty string', ''],
];

function tokenService(): BetterAuthTokenService {
  return new BetterAuthTokenService({ getSessionCookieName: () => COOKIE } as never);
}

/** A session service on a fake MongoDB whose session collection answers every aggregation with a live session */
function sessionService() {
  const pipelines: unknown[][] = [];
  const aggregate = vi.fn((pipeline: unknown[]) => {
    pipelines.push(pipeline);
    return {
      toArray: async () => [
        {
          expiresAt: new Date(Date.now() + 3_600_000),
          id: 'session-of-someone-else',
          token: 'stored-session-token',
          userDoc: { email: 'victim@example.com', id: 'victim-id', name: 'Victim' },
          userId: 'victim-id',
        },
      ],
    };
  });
  const service = new CoreBetterAuthService(
    {} as never,
    { db: { collection: () => ({ aggregate }) } } as never,
    { enabled: true } as never,
  );
  return { aggregate, pipelines, service };
}

describe('extractTokenFromRequest(): only a string cookie is a token', () => {
  it.each(NON_STRING_VALUES)('skips a session cookie holding %s', (_label, value) => {
    expect(tokenService().extractTokenFromRequest({ cookies: { [COOKIE]: value } })).toEqual({
      source: null,
      token: null,
    });
  });

  it.each(NON_STRING_VALUES)('skips a legacy `token` cookie holding %s', (_label, value) => {
    expect(tokenService().extractTokenFromRequest({ cookies: { token: value } })).toEqual({ source: null, token: null });
  });

  it('falls through to the legacy cookie when the session cookie is not a string', () => {
    expect(
      tokenService().extractTokenFromRequest({ cookies: { [COOKIE]: { $ne: null }, token: 'legacy-token' } }),
    ).toEqual({ source: 'cookie', token: 'legacy-token' });
  });

  it('paired control: a string session cookie is still the token, ahead of the legacy one', () => {
    expect(
      tokenService().extractTokenFromRequest({ cookies: { [COOKIE]: 'session-token', token: 'legacy-token' } }),
    ).toEqual({ source: 'cookie', token: 'session-token' });
  });
});

describe('getSessionByToken(): a non-string never becomes a query', () => {
  it.each(NON_STRING_VALUES)('finds no session for %s, although the store would answer one', async (_label, value) => {
    const { aggregate, service } = sessionService();

    await expect(service.getSessionByToken(value as never)).resolves.toEqual({ session: null, user: null });
    expect(aggregate).not.toHaveBeenCalled();
  });

  it('paired control: a string token is looked up by exactly that value', async () => {
    const { pipelines, service } = sessionService();

    const result = await service.getSessionByToken('stored-session-token');

    expect(pipelines[0]?.[0]).toEqual({ $match: { token: 'stored-session-token' } });
    expect(result.user?.id).toBe('victim-id');
  });
});

describe('the guard fallback as a whole: a j: cookie authenticates nobody', () => {
  /** What the role guards run when no middleware identified the caller, on the real session service */
  async function guardFallback(cookieValue: unknown) {
    const { aggregate, service } = sessionService();
    const tokens = new BetterAuthTokenService(service);
    const { token } = tokens.extractTokenFromRequest({ cookies: { [service.getSessionCookieName()]: cookieValue } });
    const user = token ? await service.getSessionByToken(token) : null;
    return { aggregate, user: user?.user ?? null };
  }

  it.each(NON_STRING_VALUES)('a session cookie holding %s signs nobody in', async (_label, value) => {
    const { aggregate, user } = await guardFallback(value);

    expect(user).toBeNull();
    expect(aggregate).not.toHaveBeenCalled();
  });

  it('paired control: the same path signs the owner of a string session token in', async () => {
    const { user } = await guardFallback('stored-session-token');

    expect(user?.id).toBe('victim-id');
  });
});
