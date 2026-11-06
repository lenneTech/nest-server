/**
 * An initial-admin setup that is killed halfway (SIGKILL, OOM, a node drain) runs no rollback. Until 12.5.x it left a
 * user without the admin role: `needsSetup` was false from then on, the setup stayed refused, and only an edit in the
 * database brought the deployment back.
 *
 * Two changes close that, and this file pins both without booting an application:
 * - `createUser` writes the admin role in the same write as the user, so a new setup can only leave an administrator
 *   without a login account behind;
 * - the boot path finishes an interrupted setup for the address `systemSetup.initialAdmin` names, and only where the
 *   configured password (or the absence of any account) proves that the user came from the setup.
 *
 * The e2e story (tests/stories/system-setup.e2e-spec.ts, "Interrupted initial admin") proves the same against a real
 * Better-Auth on MongoDB and PostgreSQL.
 */
import { ForbiddenException, Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CoreSystemSetupService } from '../../src/core/modules/system-setup/core-system-setup.service';

const ADMIN_EMAIL = 'admin@test.com';
const ADMIN_PASSWORD = 'Configured123!';
const STALE_AFTER_MS = 5 * 60_000;

interface IFakeUser {
  email: string;
  id: string;
  name?: string;
  roles?: string[];
}

interface IFakeAccount {
  password?: string;
  providerId: string;
}

/** A service whose storage is replaced: users are a counter, admins a flag, the claim answers from a queue */
class InterruptedSetupTestService extends CoreSystemSetupService {
  admins = false;
  claimAnswers: boolean[] = [];
  legacyPassword = false;
  claimReleased = 0;
  constructor(
    public userCount: number,
    configService: unknown,
    betterAuthService: unknown,
    userMapper: unknown,
    connection: unknown,
  ) {
    super(connection as never, betterAuthService as never, userMapper as never, configService as never);
  }
  /** The boot half that creates or finishes the initial admin */
  boot(): Promise<void> {
    return this.createInitialAdminFromConfig();
  }
  protected override async countUsers(): Promise<number> {
    return this.userCount;
  }
  protected override async hasAdmin(): Promise<boolean> {
    return this.admins;
  }
  protected override async hasLegacyPassword(): Promise<boolean> {
    return this.legacyPassword;
  }
  protected override async claimInitialAdminSetup(): Promise<boolean> {
    return this.claimAnswers.length ? (this.claimAnswers.shift() as boolean) : true;
  }
  protected override async releaseInitialAdminSetupClaim(): Promise<void> {
    this.claimReleased++;
  }
}

/** Better-Auth's context as far as the setup uses it; the hash of `p` is `h:p` */
function betterAuthWith(found: { accounts: IFakeAccount[]; user: IFakeUser } | null) {
  const internalAdapter = {
    createUser: vi.fn(async (user: { email: string; name?: string }) => ({
      email: user.email,
      id: 'iam-new',
      name: user.name ?? 'Admin',
    })),
    deleteUser: vi.fn(async () => undefined),
    findUserByEmail: vi.fn(async () => found),
    linkAccount: vi.fn(async () => ({})),
  };
  const password = {
    hash: vi.fn(async (plain: string) => `h:${plain}`),
    verify: vi.fn(async ({ hash, password: plain }: { hash: string; password: string }) => hash === `h:${plain}`),
  };
  const instance = { $context: Promise.resolve({ internalAdapter, password }) };
  return { instance, internalAdapter, password };
}

function serviceWith(options: { initialAdmin?: unknown; userCount: number }, instance: unknown) {
  const config = {
    configFastButReadOnly: {
      env: 'production',
      systemSetup: {
        initialAdmin: 'initialAdmin' in options ? options.initialAdmin : { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      },
    },
  };
  const betterAuthService = { getInstance: () => instance, isEnabled: () => true };
  const userMapper = {
    linkOrCreateUser: vi.fn(async (user: { email: string; id: string }) => ({ _id: user.id, email: user.email })),
    normalizePasswordForIam: (plain: string) => plain,
    syncPasswordToLegacy: vi.fn(async () => undefined),
  };
  const roleWrites: unknown[] = [];
  const connection = {
    collection: () => ({
      updateOne: vi.fn(async (filter: unknown, update: unknown) => {
        roleWrites.push({ filter, update });
        return {};
      }),
    }),
  };
  const service = new InterruptedSetupTestService(options.userCount, config, betterAuthService, userMapper, connection);
  return { roleWrites, service, userMapper };
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('CoreSystemSetupService — the admin role is part of the user', () => {
  /**
   * @regression   DEV-4050 — the role was written in a separate step after createUser, linkAccount and the sync.
   *   A process killed in between left a user without the admin role, and the setup refused for good.
   * @seen-failing Drop `roles: [RoleEnum.ADMIN],` from the createUser data in
   *   src/core/modules/system-setup/core-system-setup.service.ts — registered as mutation
   *   `system-setup-role-written-after-user` in tests/regression-mutations.json.
   */
  it('creates the initial admin with the admin role in the same write as the user', async () => {
    const { instance, internalAdapter } = betterAuthWith(null);
    const { service } = serviceWith({ userCount: 0 }, instance);

    await service.createInitialAdmin({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });

    expect(internalAdapter.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: ADMIN_EMAIL, roles: ['admin'] }),
      { method: 'admin' },
    );
  });
});

describe('CoreSystemSetupService — the boot finishes an interrupted setup', () => {
  /**
   * @regression   DEV-4050 — with users present the boot returned before looking at them, so a setup killed after
   *   createUser was never finished: no login account, and from then on no way in.
   * @seen-failing Remove the call of resumeInterruptedInitialAdmin() from createInitialAdminFromConfig() in
   *   src/core/modules/system-setup/core-system-setup.service.ts — registered as mutation
   *   `system-setup-boot-skips-interrupted-setup` in tests/regression-mutations.json.
   */
  it('gives an administrator without any account the configured password', async () => {
    const { instance, internalAdapter, password } = betterAuthWith({
      accounts: [],
      user: { email: ADMIN_EMAIL, id: 'iam-1', name: 'Admin', roles: ['admin'] },
    });
    const { roleWrites, service, userMapper } = serviceWith({ userCount: 1 }, instance);
    service.admins = true;
    const warnings = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await service.boot();

    expect(password.hash).toHaveBeenCalledWith(ADMIN_PASSWORD);
    expect(internalAdapter.linkAccount).toHaveBeenCalledWith(
      expect.objectContaining({ password: `h:${ADMIN_PASSWORD}`, providerId: 'credential', userId: 'iam-1' }),
    );
    expect(userMapper.linkOrCreateUser).toHaveBeenCalled();
    expect(roleWrites).toHaveLength(1);
    expect(userMapper.syncPasswordToLegacy).toHaveBeenCalledWith('iam-1', ADMIN_EMAIL, ADMIN_PASSWORD);
    expect(warnings.mock.calls.some(([message]) => String(message).includes('interrupted'))).toBe(true);
    expect(internalAdapter.createUser).not.toHaveBeenCalled();
    expect(internalAdapter.deleteUser).not.toHaveBeenCalled();
  });

  it('gives the role to the leftover of an older setup that already has the configured password', async () => {
    const { instance, internalAdapter } = betterAuthWith({
      accounts: [{ password: `h:${ADMIN_PASSWORD}`, providerId: 'credential' }],
      user: { email: ADMIN_EMAIL, id: 'iam-1', roles: [] },
    });
    const { roleWrites, service } = serviceWith({ userCount: 1 }, instance);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await service.boot();

    expect(internalAdapter.linkAccount).not.toHaveBeenCalled();
    expect(roleWrites).toHaveLength(1);
    expect(JSON.stringify(roleWrites[0])).toContain('admin');
  });

  it('finishes a leftover without role and without account when no administrator exists', async () => {
    const { instance, internalAdapter } = betterAuthWith({
      accounts: [],
      user: { email: ADMIN_EMAIL, id: 'iam-1', roles: [] },
    });
    const { roleWrites, service } = serviceWith({ userCount: 1 }, instance);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await service.boot();

    expect(internalAdapter.linkAccount).toHaveBeenCalled();
    expect(roleWrites).toHaveLength(1);
  });

  /**
   * @regression   DEV-4050 — the configured password is the evidence that a credential account came from the
   *   setup. Without the check, a user who signed up with the administrator's address would be made administrator
   *   at the next boot, with their own password.
   * @seen-failing Accept any credential account without comparing its password (`await context.password.verify(...)`
   *   -> `true`) in src/core/modules/system-setup/core-system-setup.service.ts — registered as mutation
   *   `system-setup-resume-trusts-any-password` in tests/regression-mutations.json.
   */
  it('leaves a user alone whose password is not the configured one', async () => {
    const { instance, internalAdapter } = betterAuthWith({
      accounts: [{ password: 'h:SomebodyElse123!', providerId: 'credential' }],
      user: { email: ADMIN_EMAIL, id: 'iam-1', roles: [] },
    });
    const { roleWrites, service, userMapper } = serviceWith({ userCount: 1 }, instance);

    await service.boot();

    expect(roleWrites).toHaveLength(0);
    expect(internalAdapter.linkAccount).not.toHaveBeenCalled();
    expect(userMapper.syncPasswordToLegacy).not.toHaveBeenCalled();
  });

  /**
   * @regression   DEV-4050 — a user without role and without account is a leftover of the setup only while the
   *   deployment has no administrator. Once one exists, the same state is an ordinary user (created without a
   *   password, say), and promoting it because its address matches the configuration would grant administration
   *   nobody decided on.
   * @seen-failing Drop the `!(await this.hasAdmin())` condition for users without role in
   *   src/core/modules/system-setup/core-system-setup.service.ts — registered as mutation
   *   `system-setup-resume-ignores-existing-admin` in tests/regression-mutations.json.
   */
  it('leaves a user without role alone when another administrator exists', async () => {
    const { instance, internalAdapter } = betterAuthWith({
      accounts: [],
      user: { email: ADMIN_EMAIL, id: 'iam-1', roles: [] },
    });
    const { roleWrites, service } = serviceWith({ userCount: 2 }, instance);
    service.admins = true;

    await service.boot();

    expect(roleWrites).toHaveLength(0);
    expect(internalAdapter.linkAccount).not.toHaveBeenCalled();
  });

  /**
   * @regression   DEV-4050 review — a Legacy-Auth administrator who has not signed in through IAM yet has the admin
   *   role and no Better-Auth account, exactly like the administrator a killed setup leaves. With its address in
   *   `initialAdmin` the boot gave it a credential account with the configured password and synced that password over
   *   its own legacy one: the real administrator was locked out.
   * @seen-failing Ignore hasLegacyPassword() for users without an account in findInterruptedInitialAdmin() in
   *   src/core/modules/system-setup/core-system-setup.service.ts — registered as mutation
   *   `system-setup-resume-overwrites-legacy-password` in tests/regression-mutations.json.
   */
  it('leaves a legacy administrator alone, whose own password lives in users.password', async () => {
    const { instance, internalAdapter } = betterAuthWith({
      accounts: [],
      user: { email: ADMIN_EMAIL, id: 'iam-1', roles: ['admin'] },
    });
    const { roleWrites, service, userMapper } = serviceWith({ userCount: 1 }, instance);
    service.admins = true;
    service.legacyPassword = true;

    await service.boot();

    expect(internalAdapter.linkAccount).not.toHaveBeenCalled();
    expect(userMapper.syncPasswordToLegacy).not.toHaveBeenCalled();
    expect(roleWrites).toHaveLength(0);
  });

  it('leaves a user alone who signs in through another provider', async () => {
    const { instance, internalAdapter } = betterAuthWith({
      accounts: [{ providerId: 'github' }],
      user: { email: ADMIN_EMAIL, id: 'iam-1', roles: [] },
    });
    const { roleWrites, service } = serviceWith({ userCount: 1 }, instance);

    await service.boot();

    expect(roleWrites).toHaveLength(0);
    expect(internalAdapter.linkAccount).not.toHaveBeenCalled();
  });

  it('does nothing for a finished setup, and does not even compare the password', async () => {
    const { instance, internalAdapter, password } = betterAuthWith({
      accounts: [{ password: `h:${ADMIN_PASSWORD}`, providerId: 'credential' }],
      user: { email: ADMIN_EMAIL, id: 'iam-1', roles: ['admin'] },
    });
    const { roleWrites, service } = serviceWith({ userCount: 1 }, instance);
    service.admins = true;

    await service.boot();

    expect(roleWrites).toHaveLength(0);
    expect(password.verify).not.toHaveBeenCalled();
    expect(internalAdapter.linkAccount).not.toHaveBeenCalled();
  });

  it('does nothing when no user carries the configured address', async () => {
    const { instance, internalAdapter } = betterAuthWith(null);
    const { roleWrites, service } = serviceWith({ userCount: 3 }, instance);

    await service.boot();

    expect(internalAdapter.findUserByEmail).toHaveBeenCalledWith(ADMIN_EMAIL, { includeAccounts: true });
    expect(roleWrites).toHaveLength(0);
  });

  it('does nothing without a usable initialAdmin', async () => {
    const { instance, internalAdapter } = betterAuthWith({
      accounts: [],
      user: { email: ADMIN_EMAIL, id: 'iam-1', roles: ['admin'] },
    });
    const { service } = serviceWith({ initialAdmin: undefined, userCount: 1 }, instance);

    await service.boot();

    expect(internalAdapter.findUserByEmail).not.toHaveBeenCalled();
  });

  it('keeps the user and releases the claim when finishing fails', async () => {
    const { instance, internalAdapter } = betterAuthWith({
      accounts: [],
      user: { email: ADMIN_EMAIL, id: 'iam-1', roles: ['admin'] },
    });
    internalAdapter.linkAccount.mockRejectedValueOnce(new Error('database gone'));
    const { service } = serviceWith({ userCount: 1 }, instance);
    service.admins = true;
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await service.boot();

    expect(internalAdapter.deleteUser).not.toHaveBeenCalled();
    expect(service.claimReleased).toBe(1);
    expect(errors.mock.calls.some(([message]) => String(message).includes('database gone'))).toBe(true);
  });

  /**
   * @regression   DEV-4050 — a process restarted within five minutes of the crash finds the claim of the dead one
   *   still held. Giving up there would leave the deployment without a way in until the next deploy.
   * @seen-failing Drop the scheduleInterruptedSetupRetry() call from createInitialAdminFromConfig() in
   *   src/core/modules/system-setup/core-system-setup.service.ts — registered as mutation
   *   `system-setup-resume-gives-up-on-held-claim` in tests/regression-mutations.json.
   */
  it('tries once more after the claim of the crashed attempt has gone stale', async () => {
    vi.useFakeTimers();
    const { instance, internalAdapter } = betterAuthWith({
      accounts: [],
      user: { email: ADMIN_EMAIL, id: 'iam-1', roles: ['admin'] },
    });
    const { roleWrites, service } = serviceWith({ userCount: 1 }, instance);
    service.admins = true;
    service.claimAnswers = [false];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await service.boot();
    expect(internalAdapter.linkAccount).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(STALE_AFTER_MS + 10_000);

    expect(internalAdapter.linkAccount).toHaveBeenCalledTimes(1);
    expect(roleWrites).toHaveLength(1);
    service.onApplicationShutdown();
  });

  it('cancels a planned retry at shutdown', async () => {
    vi.useFakeTimers();
    const { instance, internalAdapter } = betterAuthWith({
      accounts: [],
      user: { email: ADMIN_EMAIL, id: 'iam-1', roles: ['admin'] },
    });
    const { service } = serviceWith({ userCount: 1 }, instance);
    service.admins = true;
    service.claimAnswers = [false];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await service.boot();
    service.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(STALE_AFTER_MS + 10_000);

    expect(internalAdapter.linkAccount).not.toHaveBeenCalled();
  });
});

describe('CoreSystemSetupService — the HTTP init does not finish anything', () => {
  it('refuses with users present, even for the state the boot would finish', async () => {
    const { instance, internalAdapter } = betterAuthWith({
      accounts: [],
      user: { email: ADMIN_EMAIL, id: 'iam-1', roles: ['admin'] },
    });
    const { roleWrites, service } = serviceWith({ userCount: 1 }, instance);
    service.admins = true;

    await expect(service.createInitialAdmin({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })).rejects.toThrow(
      ForbiddenException,
    );
    expect(internalAdapter.linkAccount).not.toHaveBeenCalled();
    expect(roleWrites).toHaveLength(0);
  });
});
