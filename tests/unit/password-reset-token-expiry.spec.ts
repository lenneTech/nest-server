import { describe, expect, it } from 'vitest';

import { CoreUserService } from '../../src/core/modules/user/core-user.service';

/**
 * A legacy password-reset token never expired. `resetPassword()` looked it up by value and compared
 * no time at all, while the exception it threw read "Invalid or expired password reset token" — a
 * message describing a check that did not exist.
 *
 * A reset link is a bearer credential for taking over an EXISTING account, which makes it the more
 * powerful of the two token kinds this framework mints; the invitation token it is often compared
 * with only grants access to a new one. An unbounded lifetime means a mail in an archive, a
 * forwarded message or a restored backup opens the account years later.
 *
 * The gap became reachable in this very release. Until now a project on the default mailed a link
 * containing the word `undefined`, so the eternal token was unusable by accident — repairing the
 * link without adding an expiry would have turned a dead credential into a live and permanent one.
 *
 * @regression   11.38.0 — the legacy password-reset token had no expiry, and the error message
 *   claimed one.
 * @seen-failing Two registered mutations in tests/regression-mutations.json:
 *     legacy-reset-token-never-expires    treats a missing timestamp as valid, i.e. restores the
 *                                         eternal token for every row written before this release
 *     legacy-reset-expiry-invalid-opts-out  makes an invalid config value mean "no expiry"
 */
interface ExpiryApi {
  isPasswordResetTokenExpired(expiresAt: Date | null | undefined): boolean;
  passwordResetTokenExpiry(): Date | null;
  passwordResetTokenExpiryMinutes(): number;
}

describe('legacy password-reset token expiry', () => {
  const serviceWith = (configured?: unknown): ExpiryApi => {
    const service = Object.create(CoreUserService.prototype) as Record<string, unknown>;
    service.configService = {
      getFastButReadOnly: (key: string) =>
        key === 'auth.passwordReset.tokenExpiresInMinutes' ? configured : undefined,
    };
    service.userServiceLogger = { debug: () => undefined, error: () => undefined, warn: () => undefined };
    return service as unknown as ExpiryApi;
  };

  describe('resolving the configured lifetime', () => {
    it('defaults to 60 minutes, matching the IAM half of the framework', () => {
      expect(serviceWith(undefined).passwordResetTokenExpiryMinutes()).toBe(60);
    });

    it('honours a positive number, as a number or as a string from NSC__*', () => {
      expect(serviceWith(15).passwordResetTokenExpiryMinutes()).toBe(15);
      expect(serviceWith('15').passwordResetTokenExpiryMinutes()).toBe(15);
    });

    it('accepts 0 as the explicit opt-out', () => {
      expect(serviceWith(0).passwordResetTokenExpiryMinutes()).toBe(0);
      expect(serviceWith('0').passwordResetTokenExpiryMinutes()).toBe(0);
    });

    it('falls back to the DEFAULT for anything invalid, never to "unbounded"', () => {
      // The asymmetry that matters: `0` opts out, but a typo must not. Switching off the expiry of
      // an account-takeover credential is a decision somebody has to state.
      for (const value of [-5, Number.NaN, 'abc', '', '   ', null, {}, []]) {
        expect(serviceWith(value).passwordResetTokenExpiryMinutes(), `value ${JSON.stringify(value)}`).toBe(60);
      }
    });
  });

  describe('minting', () => {
    it('produces a timestamp the configured number of minutes ahead', () => {
      const before = Date.now();
      const expiry = serviceWith(15).passwordResetTokenExpiry();

      expect(expiry).toBeInstanceOf(Date);
      const delta = expiry!.getTime() - before;
      expect(delta).toBeGreaterThan(14 * 60_000);
      expect(delta).toBeLessThanOrEqual(15 * 60_000 + 1_000);
    });

    it('produces null when expiry is switched off', () => {
      expect(serviceWith(0).passwordResetTokenExpiry()).toBeNull();
    });
  });

  describe('validating', () => {
    it('treats a MISSING timestamp as expired', () => {
      // The load-bearing case: every row written before 11.38.0 has none, and reading that as
      // "valid forever" would preserve the defect permanently, since those rows never gain one.
      expect(serviceWith(60).isPasswordResetTokenExpired(undefined)).toBe(true);
      expect(serviceWith(60).isPasswordResetTokenExpired(null)).toBe(true);
    });

    it('accepts a timestamp in the future and rejects one in the past', () => {
      expect(serviceWith(60).isPasswordResetTokenExpired(new Date(Date.now() + 60_000))).toBe(false);
      expect(serviceWith(60).isPasswordResetTokenExpired(new Date(Date.now() - 1_000))).toBe(true);
    });

    it('treats an unparseable timestamp as expired', () => {
      expect(serviceWith(60).isPasswordResetTokenExpired(new Date('not a date'))).toBe(true);
    });

    it('expires nothing at all when the feature is switched off, legacy rows included', () => {
      // A project that deliberately opted out must not have its tokens invalidated by the very
      // setting it used to opt out.
      expect(serviceWith(0).isPasswordResetTokenExpired(undefined)).toBe(false);
      expect(serviceWith(0).isPasswordResetTokenExpired(new Date(Date.now() - 86_400_000))).toBe(false);
    });
  });
});
