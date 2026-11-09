import { ForbiddenException, Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '../../src/core/modules/error-code/error-codes';
import { CoreSystemSetupService } from '../../src/core/modules/system-setup/core-system-setup.service';
import {
  isSystemSetupTokenValid,
  resolveSystemSetupHttpInit,
  SYSTEM_SETUP_TOKEN_HEADER,
  SYSTEM_SETUP_TOKEN_MIN_LENGTH,
} from '../../src/core/modules/system-setup/system-setup-http-init.helper';

/**
 * `POST /system-setup/init` is anonymous: whoever reaches an API without users through it becomes the administrator.
 * Since 11.46.0 (backport of 12.4.0) it is open by default only in the local environments, and a deployment opens
 * it only on purpose.
 * The e2e story (tests/stories/system-setup-http-init.e2e-spec.ts) proves the same over HTTP; this file covers every
 * combination of environment, setting and token without booting an application.
 */

const TOKEN = 'setup-token-0123456789-abcdef';

const LOCAL_ENVS = ['local', 'ci', 'e2e', ' E2E '];
const DEPLOYED_ENVS = ['develop', 'development', 'test', 'staging', 'production', 'qa', '', undefined];

describe('resolveSystemSetupHttpInit()', () => {
  /**
   * @regression   11.46.0 (12.4.0 backport) — POST /system-setup/init was open in EVERY environment: a deployment without
   *   `systemSetup.initialAdmin` could be taken over by whoever called it before the first sign-up.
   * @seen-failing Return the local default for every environment in resolveSystemSetupHttpInit() in
   *   src/core/modules/system-setup/system-setup-http-init.helper.ts — registered as mutation
   *   `system-setup-http-init-open-by-default` in tests/regression-mutations.json.
   */
  it.each(DEPLOYED_ENVS)('closes the init without a setting in the deployed environment %j', (env) => {
    expect(resolveSystemSetupHttpInit(undefined, env)).toEqual({
      enabled: false,
      source: 'default',
      tokenRequired: false,
    });
  });

  it.each(LOCAL_ENVS)('keeps the init open without a setting in the local environment %j', (env) => {
    expect(resolveSystemSetupHttpInit(undefined, env)).toEqual({
      enabled: true,
      source: 'default',
      tokenRequired: false,
    });
  });

  it.each([...LOCAL_ENVS, ...DEPLOYED_ENVS])('opens the init without a token on `true` (env %j)', (env) => {
    expect(resolveSystemSetupHttpInit(true, env)).toEqual({ enabled: true, source: 'config', tokenRequired: false });
  });

  it.each([...LOCAL_ENVS, ...DEPLOYED_ENVS])(
    'closes the init on `false`, local environments included (env %j)',
    (env) => {
      expect(resolveSystemSetupHttpInit(false, env).enabled).toBe(false);
    },
  );

  it.each([...LOCAL_ENVS, ...DEPLOYED_ENVS])('requires the token when one is configured (env %j)', (env) => {
    expect(resolveSystemSetupHttpInit({ token: TOKEN }, env)).toEqual({
      enabled: true,
      source: 'config',
      token: TOKEN,
      tokenRequired: true,
    });
  });

  it('keeps a pre-configured token closed with `enabled: false`', () => {
    expect(resolveSystemSetupHttpInit({ enabled: false, token: TOKEN }, 'local')).toEqual({
      enabled: false,
      source: 'config',
      tokenRequired: false,
    });
  });

  /**
   * `httpInit: { token: process.env.SETUP_TOKEN }` with the variable unset must not become an open init, and neither
   * must what `NSC__SYSTEM_SETUP__HTTP_INIT__TOKEN=` turns into (the number 0).
   */
  it.each([
    ['an object without a token', {}],
    ['`enabled: true` without a token', { enabled: true }],
    ['an undefined token', { token: undefined }],
    ['a null token', { token: null }],
    ['an empty token', { token: '' }],
    ['a whitespace token', { token: ' '.repeat(SYSTEM_SETUP_TOKEN_MIN_LENGTH + 2) }],
    ['a token that is too short', { token: 'x'.repeat(SYSTEM_SETUP_TOKEN_MIN_LENGTH - 1) }],
    ['a numeric token (empty or all-digit NSC value)', { token: 0 }],
    ['a large numeric token', { token: 1234567890123456 }],
    ['a token that is an object', { token: { value: TOKEN } }],
  ])('keeps the init closed and names the problem for %s', (_label, httpInit) => {
    for (const env of ['local', 'production']) {
      const policy = resolveSystemSetupHttpInit(httpInit, env);
      expect(policy.enabled).toBe(false);
      expect(policy.tokenRequired).toBe(false);
      expect(policy.problem).toMatch(/systemSetup\.httpInit/);
    }
  });

  it.each([
    ['the string "true"', 'true'],
    ['the string "1"', '1'],
    ['a number', 1],
    ['an array', [TOKEN]],
  ])('reads %s as "not set" instead of opening the init by truthiness', (_label, httpInit) => {
    expect(resolveSystemSetupHttpInit(httpInit, 'production').enabled).toBe(false);
    expect(resolveSystemSetupHttpInit(httpInit, 'local').enabled).toBe(true);
  });
});

describe('isSystemSetupTokenValid()', () => {
  /**
   * @regression   11.46.0 (12.4.0 backport) — a token-protected init must refuse a request without the configured token.
   * @seen-failing Return true from isSystemSetupTokenValid() in
   *   src/core/modules/system-setup/system-setup-http-init.helper.ts — registered as mutation
   *   `system-setup-token-not-compared` in tests/regression-mutations.json.
   */
  it('accepts only the configured token', () => {
    expect(isSystemSetupTokenValid(TOKEN, TOKEN)).toBe(true);
    expect(isSystemSetupTokenValid(TOKEN, `${TOKEN}x`)).toBe(false);
    expect(isSystemSetupTokenValid(TOKEN, TOKEN.slice(0, -1))).toBe(false);
    expect(isSystemSetupTokenValid(TOKEN, TOKEN.toUpperCase())).toBe(false);
  });

  it.each([
    ['a missing header', undefined],
    ['an empty header', ''],
    ['a repeated header (array)', [TOKEN]],
    ['a number', 1],
  ])('refuses %s', (_label, provided) => {
    expect(isSystemSetupTokenValid(TOKEN, provided)).toBe(false);
  });

  it('never matches when no token is configured', () => {
    expect(isSystemSetupTokenValid(undefined, '')).toBe(false);
    expect(isSystemSetupTokenValid('', '')).toBe(false);
  });

  it('reads the header the documentation names', () => {
    expect(SYSTEM_SETUP_TOKEN_HEADER).toBe('x-system-setup-token');
  });
});

// =====================================================================================================================
// The service: the gate, the status, the boot report and the rollback
// =====================================================================================================================

interface IFakeOptions {
  env?: string;
  httpInit?: unknown;
  initialAdmin?: unknown;
  userCount?: number;
}

/** A service whose storage is replaced: users are a counter (the fake connection's countDocuments), the claim always wins */
class TestSystemSetupService extends CoreSystemSetupService {
  claimReleased = false;
  constructor(
    public userCount: number,
    configService: unknown,
    betterAuthService: unknown,
    userMapper: unknown,
    connection: unknown,
  ) {
    super(connection as never, betterAuthService as never, userMapper as never, configService as never);
  }
  protected override async claimInitialAdminSetup(): Promise<boolean> {
    return true;
  }
  protected override async releaseInitialAdminSetupClaim(): Promise<void> {
    this.claimReleased = true;
  }
}

function serviceWith(options: IFakeOptions, betterAuth: { instance?: unknown } = {}) {
  const config = {
    configFastButReadOnly: {
      env: options.env,
      systemSetup: { httpInit: options.httpInit, initialAdmin: options.initialAdmin },
    },
  };
  const betterAuthService = { getInstance: () => betterAuth.instance, isEnabled: () => true };
  const userMapper = {
    linkOrCreateUser: vi.fn(async (user: { email: string; id: string }) => ({ _id: user.id, email: user.email })),
    normalizePasswordForIam: (password: string) => password,
    syncPasswordToLegacy: vi.fn(async () => undefined),
  };
  const connection = {
    collection: () => ({
      countDocuments: vi.fn(async () => options.userCount ?? 0),
      updateOne: vi.fn(async () => ({})),
    }),
  };
  const service = new TestSystemSetupService(options.userCount ?? 0, config, betterAuthService, userMapper, connection);
  return { service, userMapper };
}

function forbiddenCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ForbiddenException);
    return (error as ForbiddenException).message;
  }
  return undefined;
}

describe('CoreSystemSetupService.assertHttpInitAllowed()', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * @regression   11.46.0 (12.4.0 backport) — the HTTP entry point must refuse the init where systemSetup.httpInit keeps it closed.
   * @seen-failing Remove the `!policy.enabled` refusal from assertHttpInitAllowed() in
   *   src/core/modules/system-setup/core-system-setup.service.ts — registered as mutation
   *   `system-setup-http-init-gate-removed` in tests/regression-mutations.json.
   */
  it('refuses with LTNS_0053 in a deployed environment without a setting', () => {
    const { service } = serviceWith({ env: 'production' });
    expect(forbiddenCode(() => service.assertHttpInitAllowed())).toBe(ErrorCode.SYSTEM_SETUP_HTTP_INIT_DISABLED);
    expect(ErrorCode.SYSTEM_SETUP_HTTP_INIT_DISABLED).toContain('LTNS_0053');
  });

  it('refuses with LTNS_0054 when the token is missing or wrong, and admits the right one', () => {
    const { service } = serviceWith({ env: 'production', httpInit: { token: TOKEN } });
    expect(forbiddenCode(() => service.assertHttpInitAllowed())).toBe(ErrorCode.SYSTEM_SETUP_TOKEN_INVALID);
    expect(forbiddenCode(() => service.assertHttpInitAllowed('wrong-token-wrong-token'))).toBe(
      ErrorCode.SYSTEM_SETUP_TOKEN_INVALID,
    );
    expect(ErrorCode.SYSTEM_SETUP_TOKEN_INVALID).toContain('LTNS_0054');
    expect(() => service.assertHttpInitAllowed(TOKEN)).not.toThrow();
  });

  it('admits the init in a local environment, and in a deployed one opened with `true`', () => {
    expect(() => serviceWith({ env: 'local' }).service.assertHttpInitAllowed()).not.toThrow();
    expect(() => serviceWith({ env: 'develop', httpInit: true }).service.assertHttpInitAllowed()).not.toThrow();
  });

  it('falls back to NODE_ENV when the configuration names no environment', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(forbiddenCode(() => serviceWith({}).service.assertHttpInitAllowed())).toBe(
      ErrorCode.SYSTEM_SETUP_HTTP_INIT_DISABLED,
    );
    vi.stubEnv('NODE_ENV', 'e2e');
    expect(() => serviceWith({}).service.assertHttpInitAllowed()).not.toThrow();
  });
});

describe('CoreSystemSetupService.getSetupStatus()', () => {
  it.each([
    [{ env: 'local' }, { httpInitEnabled: true, httpInitTokenRequired: false }],
    [{ env: 'production' }, { httpInitEnabled: false, httpInitTokenRequired: false }],
    [
      { env: 'production', httpInit: true },
      { httpInitEnabled: true, httpInitTokenRequired: false },
    ],
    [
      { env: 'production', httpInit: { token: TOKEN } },
      { httpInitEnabled: true, httpInitTokenRequired: true },
    ],
    [
      { env: 'local', httpInit: { token: 'short' } },
      { httpInitEnabled: false, httpInitTokenRequired: false },
    ],
  ])('reports the HTTP init for %j, independent of the user count', async (options, expected) => {
    for (const userCount of [0, 3]) {
      const status = await serviceWith({ ...options, userCount }).service.getSetupStatus();
      expect(status).toEqual({ betterAuthEnabled: true, needsSetup: userCount === 0, ...expected });
    }
  });
});

describe('CoreSystemSetupService boot report', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function logsOf(service: CoreSystemSetupService) {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    return {
      errors: () => error.mock.calls.map(([message]) => String(message)),
      run: () => (service as any).reportSetupReachability() as Promise<void>,
      warnings: () => warn.mock.calls.map(([message]) => String(message)),
    };
  }

  /**
   * @regression   11.46.0 (12.4.0 backport) — a deployed instance with no users, no initialAdmin and a closed HTTP init cannot be set
   *   up at all, and must say so at boot instead of staying silent.
   * @seen-failing Drop the `logger.error` for the closed HTTP init from reportSetupReachability() in
   *   src/core/modules/system-setup/core-system-setup.service.ts — registered as mutation
   *   `system-setup-unreachable-not-reported` in tests/regression-mutations.json.
   */
  it('logs an error naming both ways in when a deployed instance cannot be set up', async () => {
    const logs = logsOf(serviceWith({ env: 'production' }).service);
    await logs.run();
    expect(logs.errors()).toHaveLength(1);
    expect(logs.errors()[0]).toContain('NSC__SYSTEM_SETUP__INITIAL_ADMIN__EMAIL');
    expect(logs.errors()[0]).toContain('NSC__SYSTEM_SETUP__HTTP_INIT__TOKEN');
  });

  it('warns when a deployed instance without users has the init open without a token', async () => {
    const logs = logsOf(serviceWith({ env: 'develop', httpInit: true }).service);
    await logs.run();
    expect(logs.errors()).toEqual([]);
    expect(logs.warnings().some((message) => message.includes('open without a token'))).toBe(true);
  });

  it.each([
    ['a local environment', { env: 'e2e' }],
    ['users that already exist', { env: 'production', userCount: 1 }],
    ['a usable initialAdmin', { env: 'production', initialAdmin: { email: 'admin@test.com', password: 'Secret123!' } }],
    ['a token-protected init', { env: 'production', httpInit: { token: TOKEN } }],
  ])('stays silent with %s', async (_label, options) => {
    const logs = logsOf(serviceWith(options).service);
    await logs.run();
    expect(logs.errors()).toEqual([]);
    expect(logs.warnings()).toEqual([]);
  });

  it('names an all-digit ENV password (a number) instead of crashing the boot', async () => {
    const { service } = serviceWith({
      env: 'production',
      initialAdmin: { email: 'admin@test.com', password: 12345678 },
    });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect((service as any).createInitialAdminFromConfig()).resolves.toBeUndefined();
    expect(warn.mock.calls.map(([message]) => String(message))).toEqual([expect.stringContaining('not a string')]);
  });

  it('still reports an initialAdmin that cannot be used', async () => {
    const logs = logsOf(
      serviceWith({ env: 'production', initialAdmin: { email: 'not-an-email', password: 'x' } }).service,
    );
    await logs.run();
    expect(logs.errors()).toHaveLength(1);
  });

  it('logs an unusable token configuration in every environment', async () => {
    const logs = logsOf(serviceWith({ env: 'local', httpInit: { token: 0 } }).service);
    await logs.run();
    expect(logs.errors()).toHaveLength(1);
    expect(logs.errors()[0]).toContain('stays closed');
  });

  it('names a camelCase NSC variable that is never read, without its value', async () => {
    vi.stubEnv('NSC__systemSetup__initialAdmin__email', 'admin@test.com');
    vi.stubEnv('NSC__SYSTEM_SETUP__INITIAL_ADMIN__PASSWORD', 'Secret-Password-Value');
    const logs = logsOf(serviceWith({ env: 'e2e' }).service);
    await logs.run();
    expect(logs.warnings()).toEqual([expect.stringContaining('NSC__systemSetup__initialAdmin__email is not read')]);
    expect(logs.warnings()[0]).toContain('NSC__SYSTEM_SETUP__INITIAL_ADMIN__EMAIL');
    expect(logs.warnings()[0]).not.toContain('admin@test.com');
  });
});

describe('CoreSystemSetupService.createInitialAdmin() rollback', () => {
  function authInstanceWith(linkAccount: () => Promise<unknown>) {
    const internalAdapter = {
      createUser: vi.fn(async (user: { email: string }) => ({ email: user.email, id: 'iam-user-1', name: 'Admin' })),
      deleteUser: vi.fn(async () => undefined),
      linkAccount: vi.fn(linkAccount),
    };
    const instance = {
      $context: Promise.resolve({ internalAdapter, password: { hash: async (p: string) => `h:${p}` } }),
    };
    return { instance, internalAdapter };
  }

  /**
   * @regression   11.46.0 (12.4.0 backport) — a failure AFTER createUser (linkAccount, the sync, the role update) released only the
   *   claim: the IAM user stayed, `needsSetup` turned false for good and the deployment had no administrator.
   * @seen-failing Drop the rollbackInitialAdmin() call from the catch of createInitialAdmin() in
   *   src/core/modules/system-setup/core-system-setup.service.ts — registered as mutation
   *   `system-setup-failed-init-keeps-user` in tests/regression-mutations.json.
   */
  it('removes the created user when linkAccount fails, then releases the claim', async () => {
    const { instance, internalAdapter } = authInstanceWith(async () => {
      throw new Error('createLocalAccountIssuer is not a function');
    });
    const { service } = serviceWith({ env: 'e2e' }, { instance });
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(service.createInitialAdmin({ email: 'admin@test.com', password: 'Secret123!' })).rejects.toThrow(
      ForbiddenException,
    );
    expect(internalAdapter.deleteUser).toHaveBeenCalledWith('iam-user-1');
    expect(service.claimReleased).toBe(true);
  });

  it('removes the created user when the sync fails', async () => {
    const { instance, internalAdapter } = authInstanceWith(async () => ({}));
    const { service, userMapper } = serviceWith({ env: 'e2e' }, { instance });
    userMapper.linkOrCreateUser.mockResolvedValueOnce(null as never);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(service.createInitialAdmin({ email: 'admin@test.com', password: 'Secret123!' })).rejects.toThrow(
      ForbiddenException,
    );
    expect(internalAdapter.deleteUser).toHaveBeenCalledWith('iam-user-1');
  });

  it('keeps the original failure when the rollback itself fails, and says what to remove', async () => {
    const { instance, internalAdapter } = authInstanceWith(async () => {
      throw new Error('link failed');
    });
    internalAdapter.deleteUser.mockRejectedValueOnce(new Error('database gone'));
    const { service } = serviceWith({ env: 'e2e' }, { instance });
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(service.createInitialAdmin({ email: 'admin@test.com', password: 'Secret123!' })).rejects.toThrow(
      ForbiddenException,
    );
    expect(errors.mock.calls.some(([message]) => String(message).includes('could not be removed'))).toBe(true);
    expect(service.claimReleased).toBe(true);
  });

  it('removes nothing when createUser itself fails', async () => {
    const { instance, internalAdapter } = authInstanceWith(async () => ({}));
    internalAdapter.createUser.mockRejectedValueOnce(new Error('create failed'));
    const { service } = serviceWith({ env: 'e2e' }, { instance });
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(service.createInitialAdmin({ email: 'admin@test.com', password: 'Secret123!' })).rejects.toThrow(
      ForbiddenException,
    );
    expect(internalAdapter.deleteUser).not.toHaveBeenCalled();
  });

  it('keeps the user of a successful creation', async () => {
    const { instance, internalAdapter } = authInstanceWith(async () => ({}));
    const { service } = serviceWith({ env: 'e2e' }, { instance });
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await expect(
      service.createInitialAdmin({ email: 'admin@test.com', password: 'Secret123!' }),
    ).resolves.toMatchObject({
      success: true,
    });
    expect(internalAdapter.deleteUser).not.toHaveBeenCalled();
  });
});
