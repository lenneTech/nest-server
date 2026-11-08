/**
 * A sign-up for an already registered address changes nothing on the existing account, and its answer looks like that
 * of a new sign-up (12.6.6).
 *
 * With `emailAndPassword.requireEmailVerification: true` or `autoSignIn: false`, Better-Auth (1.5.0+) answers a sign-up
 * for a known address like a new one — enumeration protection: `{ token: null, user: <a generated id, the given
 * address> }`, a user it never stored. The core's sign-up paths took that placeholder for the new user:
 *  - REST `signUp()` linked it (`linkOrCreateUser()` found the REAL account by address, set its `iamId` to the
 *    placeholder's id and `verified: false`), set the real account's LEGACY password to the caller's
 *    (`syncPasswordToLegacy()` finds by address too) and answered with the real account's roles;
 *  - GraphQL `betterAuthSignUp` linked it and answered with the real account's id and roles;
 *  - the legacy sign-up with IAM enabled (`createUserViaIam()`) linked it and returned the real account — the caller
 *    got its tokens.
 *
 * The cases run the REAL Better-Auth (memory adapter) with `requireEmailVerification`, the real
 * `CoreBetterAuthService.isPersistedUser()` against it, and the real controller, resolver and legacy service methods,
 * with the mapper's writes recorded instead of executed.
 */
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { CoreAuthService } from '../../src/core/modules/auth/services/core-auth.service';
import { CoreBetterAuthUserMapper } from '../../src/core/modules/better-auth/core-better-auth-user.mapper';
import { CoreBetterAuthController } from '../../src/core/modules/better-auth/core-better-auth.controller';
import { CoreBetterAuthResolver } from '../../src/core/modules/better-auth/core-better-auth.resolver';
import { CoreBetterAuthService } from '../../src/core/modules/better-auth/core-better-auth.service';

const SECRET = 'sign-up-existing-address-secret-7d3a91c4e0b5';
const EXISTING = 'existing-owner@test.com';
const PASSWORD = 'Attacker-Chosen-Password-1';

const auth = betterAuth({
  basePath: '/iam',
  baseURL: 'http://localhost:3000',
  database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
  emailAndPassword: { enabled: true, requireEmailVerification: true },
  logger: { disabled: true },
  secret: SECRET,
});

/** The real isPersistedUser() of the service, against the real Better-Auth instance above */
const isPersistedUser = (id: string) =>
  CoreBetterAuthService.prototype.isPersistedUser.call({ getInstance: () => auth, logger: console } as never, id);

/** A CoreBetterAuthService stand-in: Better-Auth's own API, and the real persistence check */
function betterAuthService() {
  return {
    ensureSignUpEnabled: () => undefined,
    getApi: () => auth.api,
    getBasePath: () => '/iam',
    getConfig: () => ({ secret: SECRET }),
    getCookieDomain: () => undefined,
    getInstance: () => auth,
    isEnabled: () => true,
    isPersistedUser,
    resolveJwtToken: async (token: string | undefined) => token,
    revokeSession: vi.fn(async () => true),
  };
}

/** The real mapper with every write recorded, and the lookup by address answering the EXISTING account */
function recordingMapper(existingAppUser: Record<string, unknown>) {
  const mapper = new CoreBetterAuthUserMapper();
  const linkOrCreateUser = vi.spyOn(mapper, 'linkOrCreateUser').mockResolvedValue(existingAppUser as never);
  const syncPasswordToLegacy = vi.spyOn(mapper, 'syncPasswordToLegacy').mockResolvedValue(true);
  // What the lookup by address answers: the real account, with its roles
  const mapSessionUser = vi
    .spyOn(mapper, 'mapSessionUser')
    .mockImplementation(async (sessionUser: any) => ({ ...existingAppUser, iamId: sessionUser.id }) as never);
  return { linkOrCreateUser, mapper, mapSessionUser, syncPasswordToLegacy };
}

const responseStub = () => ({ clearCookie: vi.fn(), cookie: vi.fn(), req: undefined, setHeader: vi.fn() }) as any;
const emailVerification = { isEnabled: () => true } as any;

let existingIamId = '';
const existingAppUser = () => ({
  email: EXISTING,
  emailVerified: true,
  hasRole: () => true,
  iamId: existingIamId,
  id: 'app-user-of-the-existing-account',
  roles: ['admin'],
  verified: true,
});

beforeAll(async () => {
  const signedUp = await auth.api.signUpEmail({
    body: { email: EXISTING, name: 'Owner', password: 'Owner-Password-1' },
  });
  existingIamId = signedUp.user.id;
});

describe('Better-Auth itself: a sign-up for a known address answers with a placeholder', () => {
  it('answers a user Better-Auth never stored, and isPersistedUser() tells it apart', async () => {
    const response: any = await auth.api.signUpEmail({ body: { email: EXISTING, name: 'Other', password: PASSWORD } });

    expect(response.user.email).toBe(EXISTING);
    expect(response.user.id).not.toBe(existingIamId);
    expect(await isPersistedUser(response.user.id)).toBe(false);
    // Paired control: the stored user is confirmed
    expect(await isPersistedUser(existingIamId)).toBe(true);
    expect(await isPersistedUser('')).toBe(false);
  });
});

describe('REST sign-up (CoreBetterAuthController.signUp) with a known address', () => {
  function controller(mapper: CoreBetterAuthUserMapper) {
    return new CoreBetterAuthController(
      betterAuthService() as any,
      mapper,
      { getFastButReadOnly: () => undefined } as any,
      undefined,
      emailVerification,
    );
  }

  /**
   * @regression   12.6.6 — REST sign-up linked Better-Auth's placeholder to the real account (iamId, verified: false),
   *   set its legacy password to the caller's and answered with its roles.
   * @seen-failing Make `isPlaceholder` always false in CoreBetterAuthController.signUp()
   *   (src/core/modules/better-auth/core-better-auth.controller.ts) — registered as mutation
   *   `sign-up-placeholder-linked-rest` in tests/regression-mutations.json.
   */
  it('writes nothing to the existing account and answers like a new sign-up', async () => {
    const { linkOrCreateUser, mapper, syncPasswordToLegacy } = recordingMapper(existingAppUser());

    const result: any = await controller(mapper).signUp(responseStub(), {
      email: EXISTING,
      name: 'Other',
      password: PASSWORD,
      termsAndPrivacyAccepted: true,
    } as any);

    expect(linkOrCreateUser).not.toHaveBeenCalled();
    expect(syncPasswordToLegacy).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.emailVerificationRequired).toBe(true);
    expect(result.user.roles).toEqual([]);
    expect(result.user.id).not.toBe(existingIamId);
    expect(JSON.stringify(result)).not.toContain('app-user-of-the-existing-account');
  });

  it('paired control: a new address is linked and its legacy password synced', async () => {
    const { linkOrCreateUser, mapper, syncPasswordToLegacy } = recordingMapper({
      email: 'fresh-rest@test.com',
      id: 'fresh',
      roles: [],
    });

    const result: any = await controller(mapper).signUp(responseStub(), {
      email: 'fresh-rest@test.com',
      name: 'Fresh',
      password: PASSWORD,
      termsAndPrivacyAccepted: true,
    } as any);

    expect(linkOrCreateUser).toHaveBeenCalledTimes(1);
    expect(syncPasswordToLegacy).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    // The same answer shape as for the known address
    expect(Object.keys(result).sort()).toEqual(['emailVerificationRequired', 'requiresTwoFactor', 'success', 'user']);
  });
});

describe('GraphQL sign-up (CoreBetterAuthResolver.betterAuthSignUp) with a known address', () => {
  /**
   * @regression   12.6.6 — GraphQL sign-up linked Better-Auth's placeholder to the real account and answered with its id
   *   and roles.
   * @seen-failing Make `isPlaceholder` always false in CoreBetterAuthResolver.betterAuthSignUp()
   *   (src/core/modules/better-auth/core-better-auth.resolver.ts) — registered as mutation
   *   `sign-up-placeholder-linked-graphql` in tests/regression-mutations.json.
   */
  it('writes nothing and answers neither the id nor the roles of the existing account', async () => {
    const { linkOrCreateUser, mapper } = recordingMapper(existingAppUser());
    const resolver = new CoreBetterAuthResolver(betterAuthService() as any, mapper, undefined, emailVerification);

    const result: any = await resolver.betterAuthSignUp(EXISTING, PASSWORD, 'Other', true);

    expect(linkOrCreateUser).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.user.roles).toEqual([]);
    expect(result.user.id).not.toBe('app-user-of-the-existing-account');
    expect(result.user.verified).toBe(false);
  });

  it('paired control: a new address is linked', async () => {
    const { linkOrCreateUser, mapper } = recordingMapper({ email: 'fresh-gql@test.com', id: 'fresh', roles: [] });
    const resolver = new CoreBetterAuthResolver(betterAuthService() as any, mapper, undefined, emailVerification);

    await resolver.betterAuthSignUp('fresh-gql@test.com', PASSWORD, 'Fresh', true);

    expect(linkOrCreateUser).toHaveBeenCalledTimes(1);
  });
});

describe('Legacy sign-up with IAM enabled (CoreAuthService.createUserViaIam) with a known address', () => {
  function legacyService(mapper: CoreBetterAuthUserMapper, getViaEmail: (...args: any[]) => Promise<unknown>) {
    return Object.assign(Object.create(CoreAuthService.prototype), {
      betterAuthService: betterAuthService(),
      betterAuthUserMapper: mapper,
      logger: { debug: vi.fn(), log: vi.fn(), warn: vi.fn() },
      userService: { getViaEmail },
    });
  }

  /**
   * @regression   12.6.6 — the legacy sign-up linked Better-Auth's placeholder, overwrote the real account's password
   *   and returned that account, so the caller received its tokens.
   * @seen-failing Drop the `isPersistedUser()` check from CoreAuthService.createUserViaIam()
   *   (src/core/modules/auth/services/core-auth.service.ts) — registered as mutation
   *   `sign-up-placeholder-linked-legacy` in tests/regression-mutations.json.
   */
  it('refuses it as an address in use, writes nothing and returns no account', async () => {
    const { linkOrCreateUser, mapper, syncPasswordToLegacy } = recordingMapper(existingAppUser());
    const getViaEmail = vi.fn(async () => existingAppUser());

    await expect(
      (legacyService(mapper, getViaEmail) as any).createUserViaIam({ email: EXISTING, password: PASSWORD }, {}),
    ).rejects.toThrow('Email address already in use');

    expect(linkOrCreateUser).not.toHaveBeenCalled();
    expect(syncPasswordToLegacy).not.toHaveBeenCalled();
    expect(getViaEmail).not.toHaveBeenCalled();
  });

  it('paired control: a new address is created and linked', async () => {
    const { linkOrCreateUser, mapper } = recordingMapper({ email: 'fresh-legacy@test.com', id: 'fresh', roles: [] });
    const getViaEmail = vi.fn(async () => ({ email: 'fresh-legacy@test.com', id: 'fresh' }));

    const user = await (legacyService(mapper, getViaEmail) as any).createUserViaIam(
      { email: 'fresh-legacy@test.com', password: PASSWORD },
      {},
    );

    expect(linkOrCreateUser).toHaveBeenCalledTimes(1);
    expect(user.email).toBe('fresh-legacy@test.com');
  });
});
