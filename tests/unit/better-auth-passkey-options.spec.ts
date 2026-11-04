/**
 * The WebAuthn options of `betterAuth.passkey` reach the passkey plugin where it reads them.
 *
 * `@better-auth/passkey` takes `authenticatorAttachment`, `residentKey` and `userVerification` from
 * `authenticatorSelection` only — for the registration options it sends, and since 1.7.16 for the check whether a
 * response must carry user verification (`requireUserVerification: authenticatorSelection.userVerification ===
 * 'required'`). Until 12.3.1 the framework set the three at the top level, where the plugin never looks, so a project
 * configuring `userVerification: 'required'` got passkeys without enforced user verification.
 *
 * The suite records the options the framework hands to the REAL plugin (the plugin itself still runs), and checks
 * the installed plugin still reads them from `authenticatorSelection` — on an upgrade that moves them, this is the
 * case that turns red.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handedToPlugin } = vi.hoisted(() => ({ handedToPlugin: [] as Record<string, any>[] }));

vi.mock('@better-auth/passkey', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@better-auth/passkey')>();
  return {
    ...actual,
    passkey: (options: Record<string, any>) => {
      handedToPlugin.push(options);
      return actual.passkey(options as any);
    },
  };
});

import { createBetterAuthInstance } from '../../src/core/modules/better-auth/better-auth.config';

const fakeDb: any = {
  collection: () => ({
    createIndex: async () => undefined,
    findOne: async () => null,
    insertOne: async () => ({ insertedId: 'x' }),
  }),
};

/** The options the framework hands to `passkey()` for the given `betterAuth.passkey` block. */
function passkeyOptionsFor(passkey: Record<string, unknown>): Record<string, any> {
  handedToPlugin.length = 0;
  const result = createBetterAuthInstance({
    config: {
      baseUrl: 'https://api.example.com',
      enabled: true,
      passkey: { origin: 'https://example.com', rpId: 'example.com', rpName: 'Passkey Spec', ...passkey },
      secret: 'a-very-long-secret-that-is-at-least-32-characters-long-for-testing',
      trustedOrigins: ['https://example.com'],
    } as any,
    db: fakeDb,
    serverEnv: 'develop',
  } as any);
  expect(result, 'Better-Auth must build').not.toBeNull();
  expect(handedToPlugin, 'the passkey plugin must be registered exactly once').toHaveLength(1);
  return handedToPlugin[0];
}

describe('betterAuth.passkey WebAuthn options', () => {
  beforeEach(() => {
    handedToPlugin.length = 0;
  });

  /**
   * @regression   12.3.1 — `authenticatorAttachment`, `residentKey` and `userVerification` were handed to the
   *   passkey plugin at the top level, where it never reads them: `userVerification: 'required'` enforced nothing.
   * @seen-failing Spread the selection onto the top-level options again in buildPlugins() in
   *   src/core/modules/better-auth/better-auth.config.ts — registered as mutation
   *   `passkey-selection-top-level` in tests/regression-mutations.json.
   */
  it('hands the three options to the plugin as authenticatorSelection', () => {
    const options = passkeyOptionsFor({
      authenticatorAttachment: 'platform',
      residentKey: 'required',
      userVerification: 'required',
    });

    expect(options.authenticatorSelection).toEqual({
      authenticatorAttachment: 'platform',
      residentKey: 'required',
      userVerification: 'required',
    });
    expect(options).not.toHaveProperty('userVerification');
    expect(options).not.toHaveProperty('residentKey');
    expect(options).not.toHaveProperty('authenticatorAttachment');
  });

  it('passes only what is configured, so the plugin defaults fill the rest', () => {
    expect(passkeyOptionsFor({ userVerification: 'required' }).authenticatorSelection).toEqual({
      userVerification: 'required',
    });
  });

  it('sets no authenticatorSelection when none of the three is configured', () => {
    // The plugin then uses its own defaults (residentKey and userVerification "preferred"), as before 12.3.1.
    expect(passkeyOptionsFor({})).not.toHaveProperty('authenticatorSelection');
  });

  it('the installed plugin reads them from authenticatorSelection', () => {
    const source = readFileSync(join(process.cwd(), 'node_modules/@better-auth/passkey/dist/index.mjs'), 'utf8');

    // Where the registration options come from, and where user verification is required on verify
    expect(source).toContain('...opts.authenticatorSelection || {}');
    expect(source).toContain(
      'requireUserVerification: options.authenticatorSelection?.userVerification === "required"',
    );
    // Nothing reads the three from the top level of the plugin options
    expect(source).not.toMatch(/\b(?:opts|options)\.(?:userVerification|residentKey|authenticatorAttachment)\b/);
  });
});
