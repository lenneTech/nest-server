/**
 * Every native Better-Auth route that carries a password gets it in the shape the credential is stored in.
 *
 * Sign-in and sign-up normalize (a client may send plaintext or sha256), and so do the reset routes
 * (`PASSWORD_RESET_PATHS`). The other native routes with a password in their body were forwarded untouched:
 * a plaintext `password` reached Better-Auth's `scrypt(plaintext)` comparison against
 * `scrypt(sha256(...))`. nuxt-extensions hashes in the browser and never noticed; any other client did.
 *
 * Two halves: the contract (each declared route and field still exists in the INSTALLED better-auth, so a
 * rename upstream fails here instead of silently skipping the normalization) and the behaviour.
 *
 * @regression   12.0.0 — `/two-factor/enable`, `/two-factor/disable`, `/two-factor/generate-backup-codes`,
 *   `/two-factor/get-totp-uri`, `/delete-user` and `/verify-password` answered "Invalid password" for the
 *   right plaintext password, and `/change-password` stored a plaintext `newPassword` as `scrypt(plaintext)`,
 *   locking the account out at the next sign-in. Found through the 2FA story tests, whose requests had
 *   always failed and whose catch blocks had hidden it.
 * @seen-failing Make normalizeNativePasswords() in src/core/modules/better-auth/core-better-auth-api.middleware.ts
 *   return before touching the body — registered as mutation `native-password-routes-not-normalized` in
 *   tests/regression-mutations.json.
 */
import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CoreBetterAuthApiMiddleware,
  normalizeIamRoutePath,
  PASSWORD_FIELD_PATHS,
} from '../../src/core/modules/better-auth/core-better-auth-api.middleware';
import { CoreBetterAuthUserMapper } from '../../src/core/modules/better-auth/core-better-auth-user.mapper';

const betterAuthDist = resolve(process.cwd(), 'node_modules/better-auth/dist');

/** Where each route's body schema lives in the installed package. */
const UPSTREAM_SOURCE: Record<string, string> = {
  '/change-password': 'api/routes/update-user.mjs',
  '/delete-user': 'api/routes/update-user.mjs',
  '/two-factor/disable': 'plugins/two-factor/index.mjs',
  '/two-factor/enable': 'plugins/two-factor/index.mjs',
  '/two-factor/generate-backup-codes': 'plugins/two-factor/backup-codes/index.mjs',
  '/two-factor/get-totp-uri': 'plugins/two-factor/totp/index.mjs',
  '/verify-password': 'api/routes/password.mjs',
};

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function middleware(): any {
  const betterAuthService = { getConfig: () => ({ options: {} }) } as any;
  return new CoreBetterAuthApiMiddleware(betterAuthService, undefined, new CoreBetterAuthUserMapper());
}

describe('PASSWORD_FIELD_PATHS matches the installed better-auth', () => {
  for (const entry of PASSWORD_FIELD_PATHS) {
    it(`${entry.path} is a route of better-auth and declares ${[...entry.verify, ...entry.set].join(', ')}`, () => {
      const source = UPSTREAM_SOURCE[entry.path];
      expect(source, `no upstream source recorded for ${entry.path}`).toBeDefined();
      const upstream = readFileSync(resolve(betterAuthDist, source), 'utf8');
      expect(upstream).toContain(`createAuthEndpoint("${entry.path}"`);
      for (const field of [...entry.verify, ...entry.set]) {
        // The 2FA routes declare `password: passwordSchema` (a shared `z.string()`), the core routes inline it.
        expect(upstream, `${source} no longer declares \`${field}\``).toMatch(new RegExp(`${field}: (z\\.string\\(\\)|passwordSchema)`));
      }
    });
  }
});

describe('normalizeNativePasswords()', () => {
  it('normalizes a plaintext password a route verifies', () => {
    const req = { body: { password: 'Plain-Password-1' } };
    middleware().normalizeNativePasswords(req, '/two-factor/enable');
    expect(req.body.password).toBe(sha256('Plain-Password-1'));
  });

  it('normalizes both passwords of change-password, so the new one is stored the way sign-in checks it', () => {
    const req = { body: { currentPassword: 'Current-Password-1', newPassword: 'New-Password-123', revokeOtherSessions: true } };
    middleware().normalizeNativePasswords(req, '/change-password/');
    expect(req.body).toEqual({
      currentPassword: sha256('Current-Password-1'),
      newPassword: sha256('New-Password-123'),
      revokeOtherSessions: true,
    });
  });

  it('leaves an already hashed password as it is (what nuxt-extensions sends)', () => {
    const hashed = sha256('whatever');
    const req = { body: { password: hashed } };
    middleware().normalizeNativePasswords(req, '/delete-user');
    expect(req.body.password).toBe(hashed);
  });

  it('refuses a plaintext NEW password outside the length policy, which a hash would hide from Better-Auth', () => {
    const req = { body: { currentPassword: 'Current-Password-1', newPassword: 'short' } };
    expect(() => middleware().normalizeNativePasswords(req, '/change-password')).toThrow(BadRequestException);
  });

  it('touches nothing on a route without a password field', () => {
    const req = { body: { password: 'Plain-Password-1' } };
    middleware().normalizeNativePasswords(req, '/update-user');
    expect(req.body.password).toBe('Plain-Password-1');
  });
});

describe('route matching on a hostile path', () => {
  it('trims trailing slashes and case the way the route tables are written', () => {
    expect(normalizeIamRoutePath('/Change-Password//')).toBe('/change-password');
    expect(normalizeIamRoutePath('/two-factor/enable')).toBe('/two-factor/enable');
    expect(normalizeIamRoutePath('///')).toBe('');
  });

  /**
   * @regression   12.0.0 (pre-release) — both route matchers trimmed with `relativePath.replace(/\/+$/, '')`, which
   *   backtracks quadratically on a run of slashes followed by another character. Every `/iam/*` request passes both,
   *   before authentication or rate limiting: a 16 KB path blocked the event loop for ~230 ms (found by the 12.0.0
   *   review's performance reviewer).
   * @seen-failing Put the regex back into normalizeIamRoutePath() in
   *   src/core/modules/better-auth/core-better-auth-api.middleware.ts — registered as mutation
   *   `iam-route-path-quadratic-regex` in tests/regression-mutations.json.
   */
  it('matches a path of 40,000 slashes in linear time', () => {
    const path = `/${'/'.repeat(40_000)}x`;
    const instance = middleware();
    const start = performance.now();
    instance.normalizeNativePasswords({ body: {} }, path);
    instance.normalizeResetPassword({ body: {} }, path);
    expect(performance.now() - start).toBeLessThan(100);
  });
});
