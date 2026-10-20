/**
 * `CoreBetterAuthService.getBaseUrl()` must answer the URL Better-Auth actually runs on.
 *
 * Better-Auth signs JWTs with its `baseURL` as `iss` / `aud`, and the framework verifies Bearer JWTs
 * against `getBaseUrl()`, so the two must be one value by construction. The instance is built with a
 * fake MongoDB `db` (`betterAuth()` only stores the adapter reference), so this needs no database.
 * The Bearer round trip itself is pinned by `tests/better-auth-jwt-issuer.e2e-spec.ts`.
 */
import { describe, expect, it } from 'vitest';

import { createBetterAuthInstance } from '../../src/core/modules/better-auth/better-auth.config';
import { CoreBetterAuthService } from '../../src/core/modules/better-auth/core-better-auth.service';

const fakeDb: any = {
  collection: () => ({
    createIndex: async () => undefined,
    findOne: async () => null,
    insertOne: async () => ({ insertedId: 'x' }),
  }),
};

const VALID_SECRET = 'a-very-long-secret-that-is-at-least-32-characters-long-for-testing';

function serviceFor(config: Record<string, unknown>, serverBaseUrl?: string): CoreBetterAuthService {
  const result = createBetterAuthInstance({ config: config as any, db: fakeDb, serverBaseUrl, serverEnv: 'develop' });
  expect(result).not.toBeNull();
  return new CoreBetterAuthService(result!.instance as any, undefined, config as any, undefined, undefined);
}

describe('CoreBetterAuthService.getBaseUrl()', () => {
  it('answers the server baseUrl when only that is set — the URL Better-Auth signs JWTs with', () => {
    const service = serviceFor({ enabled: true, secret: VALID_SECRET }, 'https://api.example.com');

    expect((service.getInstance() as any).options.baseURL).toBe('https://api.example.com');
    expect(service.getBaseUrl()).toBe('https://api.example.com');
  });

  /**
   * @regression   11.43.1 review — getBaseUrl() returned the configured string, while Better-Auth signs
   *   with its ORIGIN (`createAuthContext()` stores `new URL(baseURL).origin`). A trailing slash, a path
   *   or a default port in `NSC__BASE_URL` therefore still refused every Bearer JWT with 401.
   * @seen-failing Return `instanceBaseUrl` instead of its origin in getBaseUrl() in
   *   src/core/modules/better-auth/core-better-auth.service.ts — registered as mutation
   *   `base-url-origin-dropped-unit` in tests/regression-mutations.json.
   */
  it.each([
    ['a trailing slash', 'https://api.example.com/'],
    ['a path', 'https://example.com/api'],
    ['the default port', 'https://api.example.com:443'],
  ])('answers exactly the value Better-Auth signs with when the server baseUrl has %s', async (_case, serverBaseUrl) => {
    const service = serviceFor({ enabled: true, secret: VALID_SECRET }, serverBaseUrl);
    const signedWith = (await (service.getInstance() as any).$context).options.baseURL;

    expect(signedWith).toBe(new URL(serverBaseUrl).origin);
    expect(service.getBaseUrl()).toBe(signedWith);
  });

  it('answers betterAuth.baseUrl when it is set, over the server baseUrl', () => {
    const service = serviceFor(
      { baseUrl: 'https://auth.example.com', enabled: true, secret: VALID_SECRET },
      'https://api.example.com',
    );

    expect(service.getBaseUrl()).toBe('https://auth.example.com');
  });

  it('falls back to the configured value, then to localhost, without an instance (Better-Auth disabled)', () => {
    expect(
      new CoreBetterAuthService(null, undefined, { baseUrl: 'https://api.example.com' } as any).getBaseUrl(),
    ).toBe('https://api.example.com');
    expect(new CoreBetterAuthService(null, undefined, {} as any).getBaseUrl()).toBe('http://localhost:3000');
  });
});
