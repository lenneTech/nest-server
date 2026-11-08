import { describe, expect, it } from 'vitest';

import { createBetterAuthInstance } from '../../src/core/modules/better-auth/better-auth.config';

/**
 * The origin check runs whatever the environment is called (12.8.2).
 *
 * Better-Auth decides the origin check itself while `advanced.disableOriginCheck` is unset: `isTest()` —
 * `NODE_ENV === 'test'` or a truthy `TEST` variable — switches it off. With it go the CSRF check (backward
 * compatibility in Better-Auth's origin-check middleware) and the validation of `callbackURL` / `redirectTo` against
 * `trustedOrigins`. A deployed stage named `test` is exactly that environment: `POST /iam/request-password-reset` took
 * any `redirectTo`, and the framework's reset mail (`buildPasswordResetUrl()`) carried it, with a valid token, to the
 * caller's page.
 *
 * The unit runner runs with `NODE_ENV=test`, so every case below runs in the environment the defect needs. They build
 * the REAL `createBetterAuthInstance()` and, where it matters, send the request through Better-Auth's own handler.
 */

/** Minimal MongoDB `Db` stand-in: every lookup finds nothing. */
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

const VALID_SECRET = 'a-very-long-secret-that-is-at-least-32-characters-long-for-testing';
const BASE_URL = 'http://localhost:3000';

/** The Better-Auth instance for the given `betterAuth` configuration. */
function instanceFor(config: Record<string, unknown> = {}): any {
  const result = createBetterAuthInstance({
    config: { baseUrl: BASE_URL, enabled: true, secret: VALID_SECRET, ...config } as any,
    db: fakeDb,
  } as any);
  expect(result).not.toBeNull();
  return result!.instance;
}

/** `POST /iam/request-password-reset` through Better-Auth's own handler, as a browser on the API origin sends it */
async function requestReset(instance: any, redirectTo: string): Promise<{ body: any; status: number }> {
  const response: Response = await instance.handler(
    new Request(`${BASE_URL}/iam/request-password-reset`, {
      body: JSON.stringify({ email: 'victim@example.com', redirectTo }),
      headers: { 'content-type': 'application/json', origin: BASE_URL },
      method: 'POST',
    }),
  );
  const text = await response.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { body, status: response.status };
}

describe('Better-Auth origin check under NODE_ENV=test', () => {
  it('runs in the environment the defect needs', () => {
    // Guards the premise: without it every case below would pass for the wrong reason.
    expect(process.env.NODE_ENV).toBe('test');
  });

  /**
   * @regression   12.8.2 — with `advanced.disableOriginCheck` unset, Better-Auth's `isTest()` switched the origin
   *   check off on every stage with NODE_ENV=test, and `/request-password-reset` took any `redirectTo` into the mail.
   * @seen-failing Remove `disableOriginCheck: false` from the `advanced` block in createBetterAuthInstance()
   *   (src/core/modules/better-auth/better-auth.config.ts) — registered as mutation
   *   `iam-origin-check-follows-node-env` in tests/regression-mutations.json.
   */
  it('keeps the origin check on and refuses a foreign redirectTo for a password reset', async () => {
    const instance = instanceFor();

    expect((await instance.$context).skipOriginCheck).toBe(false);

    const { body, status } = await requestReset(instance, 'https://attacker.example/reset');
    expect(status).toBe(403);
    expect(body?.code).toBe('INVALID_REDIRECT_URL');
  });

  it('paired control: a redirectTo on a trusted origin passes the check', async () => {
    const { body, status } = await requestReset(instanceFor(), '/auth/reset-password');

    expect(status).not.toBe(403);
    expect(body?.code).not.toBe('INVALID_REDIRECT_URL');
  });

  /**
   * @regression   12.8.2 — a project setting `options.advanced` must not hand the decision back to `isTest()` through
   *   the merge, neither with other keys nor with an explicitly `undefined` `disableOriginCheck`.
   * @seen-failing Drop the `?? false` from the merged `disableOriginCheck` in createBetterAuthInstance()
   *   (src/core/modules/better-auth/better-auth.config.ts) — registered as mutation
   *   `iam-origin-check-merge-drops-pin` in tests/regression-mutations.json.
   */
  it.each([
    ['other advanced options', { defaultCookieAttributes: { partitioned: true } }],
    ['an explicitly undefined disableOriginCheck', { disableOriginCheck: undefined }],
  ])('keeps the origin check on when a project sets %s', async (_label, advanced) => {
    const instance = instanceFor({ options: { advanced } });

    expect((await instance.$context).skipOriginCheck).toBe(false);
  });

  it("a project's explicit decision still wins", async () => {
    const instance = instanceFor({ options: { advanced: { disableOriginCheck: true } } });

    expect((await instance.$context).skipOriginCheck).toBe(true);
  });
});
