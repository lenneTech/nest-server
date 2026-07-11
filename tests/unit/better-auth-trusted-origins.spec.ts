/**
 * Unit Tests: buildTrustedOrigins — Server-level CORS propagation to BetterAuth
 *
 * Verifies that the `serverCorsConfig` parameter added in v11.25.0 correctly
 * propagates to BetterAuth's trustedOrigins, keeping the three CORS layers
 * (GraphQL, REST, BetterAuth) in sync.
 */

import { describe, expect, it } from 'vitest';

import { resolveServerUrls } from '../../src/core/common/helpers/cookies.helper';
import { buildTrustedOrigins } from '../../src/core/modules/better-auth/better-auth.config';

// Helper to construct the options shape expected by buildTrustedOrigins
const opts = (args: {
  passkeyEnabled?: boolean;
  passkeyTrustedOrigins?: string[];
  resolvedAppUrl?: string;
  resolvedBaseUrl?: string;
  serverCorsConfig?: any;
}) => ({
  passkeyNormalization: {
    enabled: args.passkeyEnabled ?? false,
    normalizedConfig: null,
    trustedOrigins: args.passkeyTrustedOrigins ?? null,
    warnings: [],
  } as any,
  resolvedUrls: {
    appUrl: args.resolvedAppUrl,
    baseUrl: args.resolvedBaseUrl,
    rpId: undefined,
    warnings: [],
  } as any,
  serverCorsConfig: args.serverCorsConfig,
});

describe('buildTrustedOrigins', () => {
  // -------------------------------------------------------------------------
  // Priority 1: Explicit betterAuth.trustedOrigins always wins
  // -------------------------------------------------------------------------

  it('should use betterAuth.trustedOrigins when explicitly configured (overrides serverCorsConfig)', () => {
    const result = buildTrustedOrigins(
      { trustedOrigins: ['https://explicit.example.com'] } as any,
      opts({
        resolvedAppUrl: 'https://example.com',
        serverCorsConfig: { allowedOrigins: ['https://from-cors.example.com'] },
      }),
    );
    expect(result).toEqual(['https://explicit.example.com']);
  });

  // -------------------------------------------------------------------------
  // Priority 2: serverCorsConfig disabled → empty array
  // -------------------------------------------------------------------------

  it('should return empty array when serverCorsConfig === false', () => {
    const result = buildTrustedOrigins(
      {} as any,
      opts({ resolvedAppUrl: 'https://example.com', serverCorsConfig: false }),
    );
    expect(result).toEqual([]);
  });

  it('should return empty array when serverCorsConfig.enabled === false', () => {
    const result = buildTrustedOrigins(
      {} as any,
      opts({ resolvedAppUrl: 'https://example.com', serverCorsConfig: { enabled: false } }),
    );
    expect(result).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Priority 3: serverCorsConfig.allowAll falls through to the appUrl/passkey rules.
  //
  // Returning `undefined` here would NOT make BetterAuth "allow all origins" —
  // without trustedOrigins it trusts only its own baseURL, so the app origin is
  // rejected and origin-checked endpoints (two-factor/enable, passkey) answer
  // 403 INVALID_ORIGIN. That used to break 2FA + passkeys in local dev and CI,
  // which are exactly the setups that run with allowAll.
  // -------------------------------------------------------------------------

  it('should trust the appUrl when serverCorsConfig.allowAll === true', () => {
    const result = buildTrustedOrigins(
      {} as any,
      opts({ resolvedAppUrl: 'https://example.com', serverCorsConfig: { allowAll: true } }),
    );
    expect(result).toEqual(['https://example.com']);
  });

  // Rule 5 (passkey trustedOrigins) is reached before rule 6 (appUrl). The fixture below is a
  // deliberate CONSTRUCTION: it gives the passkey normalization a value that differs from the
  // appUrl purely to prove rule 5 sources the origins from the passkey normalization, not from
  // the appUrl. In production the two are always equal — `normalizePasskeyConfig()` computes
  // `trustedOrigins = config.trustedOrigins?.length ? config.trustedOrigins : [appUrl]`, and a
  // non-empty `config.trustedOrigins` would already have returned at rule 1 — so whenever rule 5
  // is actually reached, `passkeyNormalization.trustedOrigins` is exactly `[appUrl]`.
  it('should source trustedOrigins from the passkey normalization (rule 5) under allowAll', () => {
    const result = buildTrustedOrigins(
      {} as any,
      opts({
        passkeyEnabled: true,
        passkeyTrustedOrigins: ['https://app.example.com'],
        resolvedAppUrl: 'https://example.com',
        serverCorsConfig: { allowAll: true },
      }),
    );
    expect(result).toEqual(['https://app.example.com']);
  });

  // The realistic shape: allowAll + passkey enabled, passkey origins = [appUrl] (the only value
  // normalizePasskeyConfig can produce at rule 5). The app origin must end up trusted.
  it('should trust the appUrl under allowAll + passkey (production shape)', () => {
    const result = buildTrustedOrigins(
      {} as any,
      opts({
        passkeyEnabled: true,
        passkeyTrustedOrigins: ['https://example.com'],
        resolvedAppUrl: 'https://example.com',
        serverCorsConfig: { allowAll: true },
      }),
    );
    expect(result).toEqual(['https://example.com']);
  });

  it('should still return undefined for allowAll when no appUrl can be resolved', () => {
    const result = buildTrustedOrigins({} as any, opts({ serverCorsConfig: { allowAll: true } }));
    expect(result).toBeUndefined();
  });

  it('should let an explicit trustedOrigins list override allowAll', () => {
    const result = buildTrustedOrigins(
      { trustedOrigins: ['https://explicit.example.com'] } as any,
      opts({ resolvedAppUrl: 'https://example.com', serverCorsConfig: { allowAll: true } }),
    );
    expect(result).toEqual(['https://explicit.example.com']);
  });

  // Composition: the host-split app origin resolved by resolveServerUrls (from a
  // `lt dev up` `api.<slug>.localhost` baseUrl) must reach BetterAuth's trustedOrigins.
  // The unit tests above hand-supply `resolvedAppUrl`; this threads the real resolver
  // output through buildTrustedOrigins to prove the two halves actually compose.
  it('should trust the host-split app origin threaded from resolveServerUrls (composition)', () => {
    const resolved = resolveServerUrls({ baseUrl: 'https://api.crm.localhost', env: 'local' });
    expect(resolved.appUrl).toBe('https://crm.localhost');

    const result = buildTrustedOrigins(
      {} as any,
      opts({ resolvedAppUrl: resolved.appUrl, serverCorsConfig: { allowAll: true } }),
    );
    expect(result).toEqual(['https://crm.localhost']);
  });

  // -------------------------------------------------------------------------
  // Priority 4: serverCorsConfig.allowedOrigins → merge with resolved URLs
  // -------------------------------------------------------------------------

  it('should merge allowedOrigins with appUrl and baseUrl (deduplicated)', () => {
    const result = buildTrustedOrigins(
      {} as any,
      opts({
        resolvedAppUrl: 'https://example.com',
        resolvedBaseUrl: 'https://api.example.com',
        serverCorsConfig: { allowedOrigins: ['https://admin.example.com'] },
      }),
    );
    expect(result).toContain('https://admin.example.com');
    expect(result).toContain('https://example.com');
    expect(result).toContain('https://api.example.com');
    expect(result?.length).toBe(3);
  });

  it('should place appUrl + baseUrl BEFORE allowedOrigins for consistency with buildCorsConfig', () => {
    const result = buildTrustedOrigins(
      {} as any,
      opts({
        resolvedAppUrl: 'https://example.com',
        resolvedBaseUrl: 'https://api.example.com',
        serverCorsConfig: { allowedOrigins: ['https://admin.example.com'] },
      }),
    );
    expect(result).toEqual([
      'https://example.com',
      'https://api.example.com',
      'https://admin.example.com',
    ]);
  });

  it('should deduplicate when allowedOrigins overlaps with appUrl', () => {
    const result = buildTrustedOrigins(
      {} as any,
      opts({
        resolvedAppUrl: 'https://example.com',
        serverCorsConfig: { allowedOrigins: ['https://example.com', 'https://admin.example.com'] },
      }),
    );
    expect(result).toEqual(expect.arrayContaining(['https://example.com', 'https://admin.example.com']));
    expect(result?.length).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Priority 5: Passkey trustedOrigins fallback
  // -------------------------------------------------------------------------

  it('should use passkey trustedOrigins when no serverCorsConfig and passkey enabled', () => {
    const result = buildTrustedOrigins(
      {} as any,
      opts({
        passkeyEnabled: true,
        passkeyTrustedOrigins: ['https://passkey.example.com'],
        resolvedAppUrl: 'https://example.com',
      }),
    );
    expect(result).toEqual(['https://passkey.example.com']);
  });

  // -------------------------------------------------------------------------
  // Priority 6: Fallback to resolved appUrl
  // -------------------------------------------------------------------------

  it('should fallback to resolved appUrl when no other config', () => {
    const result = buildTrustedOrigins({} as any, opts({ resolvedAppUrl: 'https://example.com' }));
    expect(result).toEqual(['https://example.com']);
  });

  // -------------------------------------------------------------------------
  // Priority 7: Nothing configured → undefined (BetterAuth default)
  // -------------------------------------------------------------------------

  it('should return undefined when nothing is configured', () => {
    const result = buildTrustedOrigins({} as any, opts({}));
    expect(result).toBeUndefined();
  });
});
