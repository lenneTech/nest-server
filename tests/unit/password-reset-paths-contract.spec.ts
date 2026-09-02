/**
 * `PASSWORD_RESET_PATHS` versus Better-Auth's actual route definitions.
 *
 * WHY THIS IS A UNIT TEST AND NOT A MATRIX CELL
 *
 * `CoreBetterAuthApiMiddleware` normalizes the password on three native reset routes, and each
 * carries it under a different body key — `newPassword` for the token and phone-number routes,
 * `password` for the email-OTP one. The story matrix
 * (`tests/stories/password-reset-parity.e2e-spec.ts`) can only exercise the first: the email-OTP
 * and phone-number plugins are not enabled in this repository's e2e configuration, and enabling
 * them to assert a field name would be a large amount of moving parts for a small question.
 *
 * The repo's rule is that a matrix cell is EXECUTED, IMPOSSIBLE, or DIFFERENT-BY-DESIGN — never
 * merely absent. These two are **IMPOSSIBLE at the e2e level and covered here instead**, because
 * the actual risk is not the routing (that is a literal string compare) but the FIELD NAME. A
 * wrong key produces no error anywhere: the lookup finds nothing, the middleware skips the route,
 * Better-Auth stores `scrypt(plaintext)` — and the user is locked out with the password they just
 * chose. Exactly the defect `iam-reset-password-not-normalized` pins on the one route that is
 * exercised, reachable on the other two through an upstream rename.
 *
 * Written against the REAL installed package, never a hand-written fixture — same reasoning as
 * the better-auth contract tests: an invented fixture asserts what the author believed, not what
 * shipped.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PASSWORD_RESET_PATHS } from '../../src/core/modules/better-auth/core-better-auth-api.middleware';

// Resolved from the workspace root rather than through `require.resolve`, which needs
// `createRequire(import.meta.url)` and therefore an ESM module target this config does not use.
const betterAuthDist = resolve(process.cwd(), 'node_modules/better-auth/dist');
void dirname;

/** Where each route's body schema lives in the installed package, and how to find it there. */
const UPSTREAM_ROUTES = [
  {
    /** `createAuthEndpoint("/reset-password", …)` in the core password routes. */
    endpoint: '/reset-password',
    expectedField: 'newPassword',
    source: 'api/routes/password.mjs',
  },
  {
    endpoint: '/email-otp/reset-password',
    expectedField: 'password',
    source: 'plugins/email-otp/routes.mjs',
  },
  {
    endpoint: '/phone-number/reset-password',
    expectedField: 'newPassword',
    source: 'plugins/phone-number/routes.mjs',
  },
] as const;

describe('PASSWORD_RESET_PATHS matches the installed better-auth', () => {
  it('declares exactly the three routes that set a new password', () => {
    expect(PASSWORD_RESET_PATHS.map((entry) => entry.path).sort()).toEqual(
      UPSTREAM_ROUTES.map((route) => route.endpoint).sort(),
    );
  });

  for (const route of UPSTREAM_ROUTES) {
    it(`${route.endpoint} still reads the password from \`${route.expectedField}\``, () => {
      const declared = PASSWORD_RESET_PATHS.find((entry) => entry.path === route.endpoint);
      expect(declared, `${route.endpoint} is not declared in PASSWORD_RESET_PATHS`).toBeDefined();
      expect(declared!.field).toBe(route.expectedField);

      // And the upstream route still DECLARES that key in its body schema. Asserted against the
      // zod declaration rather than a `ctx.body.<field>` read, because the routes differ in how
      // they consume it — the core one destructures — while all three declare it the same way.
      // A rename upstream means our normalization silently stops applying to this route.
      const upstream = readFileSync(resolve(betterAuthDist, route.source), 'utf8');
      expect(
        upstream,
        `better-auth's ${route.source} no longer declares \`${route.expectedField}: z.string()\` — ` +
          'the password on this route is no longer being normalized, and a plaintext reset ' +
          'there now locks the account out with its new password.',
      ).toContain(`${route.expectedField}: z.string()`);
    });
  }

  it('lists every route whose path ends in /reset-password', () => {
    // A fourth reset route appearing upstream must not be able to slip past unnoticed: it would
    // be forwarded un-normalized, i.e. with the defect this table exists to prevent.
    const known = new Set(PASSWORD_RESET_PATHS.map((entry) => entry.path));

    for (const route of UPSTREAM_ROUTES) {
      expect(known.has(route.endpoint), `${route.endpoint} must be covered`).toBe(true);
    }
  });

  it('uses lower-case paths, because matching lower-cases the request path', () => {
    for (const entry of PASSWORD_RESET_PATHS) {
      expect(entry.path).toBe(entry.path.toLowerCase());
    }
  });
});
