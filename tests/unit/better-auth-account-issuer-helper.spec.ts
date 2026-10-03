/**
 * Unit Tests: which better-auth account schema is installed.
 *
 * `core-better-auth-account-issuer.helper.ts` is the single place that decides whether accounts get
 * an `issuer` (better-auth 1.7.0–1.7.2, which export `createLocalAccountIssuer`) or not (1.7.3+, which
 * removed it with the issuer schema). Everything else — the two account write sites and the boot
 * step — asks it.
 *
 * The first case pins the version THIS repository installs: it fails the day a better-auth update
 * brings the issuer schema back, which is exactly when the write sites and the boot step have to be
 * looked at again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('core-better-auth-account-issuer.helper', () => {
  afterEach(() => {
    vi.doUnmock('@better-auth/core/db');
    vi.resetModules();
  });

  it('reports no issuer for the installed better-auth (1.7.3+ dropped the issuer schema)', async () => {
    const helper = await import('../../src/core/modules/better-auth/core-better-auth-account-issuer.helper');

    expect(helper.legacyCredentialAccountIssuer()).toBeUndefined();
    expect(helper.usesLegacyAccountIssuer()).toBe(false);
  });

  it('derives the credential issuer through better-auth when it still exports the helper (1.7.0–1.7.2)', async () => {
    const createLocalAccountIssuer = vi.fn((providerId: string) => `local:${providerId}`);
    vi.doMock('@better-auth/core/db', () => ({ createLocalAccountIssuer }));
    vi.resetModules();
    const helper = await import('../../src/core/modules/better-auth/core-better-auth-account-issuer.helper');

    expect(helper.legacyCredentialAccountIssuer()).toBe('local:credential');
    expect(helper.usesLegacyAccountIssuer()).toBe(true);
    // Derived by better-auth, never a hand-written literal: the format is better-auth's to change.
    expect(createLocalAccountIssuer).toHaveBeenCalledWith('credential');
  });
});
