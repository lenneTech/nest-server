import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { ForbiddenException, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { InjectConnection } from '../../common/persistence/mongo/mongoose-compat.js';
import { isEmail } from 'class-validator';
import type { Collection } from 'mongodb';
import type { Connection } from 'mongoose';

import {
  defaultSqlLockStore,
  SYSTEM_SETUP_CLAIM_STALE_AFTER_MS,
  SYSTEM_SETUP_LOCK_COLLECTION,
  SYSTEM_SETUP_LOCK_KEY,
  systemSetupMongoLocks,
} from '../../common/persistence/infrastructure-locks.js';
import { RoleEnum } from '../../common/enums/role.enum.js';
import type { LockStore } from '../../common/persistence/lock-store.interface.js';
import { isLocalEnv } from '../../common/helpers/cookies.helper.js';
import type { ISystemSetupInitialAdmin } from '../../common/interfaces/server-options.interface.js';
import { ConfigService } from '../../common/services/config.service.js';
import { legacyCredentialAccountIssuer } from '../better-auth/core-better-auth-account-issuer.helper.js';
import { CoreBetterAuthUserMapper } from '../better-auth/core-better-auth-user.mapper.js';
import { CoreBetterAuthService } from '../better-auth/core-better-auth.service.js';
import { ErrorCode } from '../error-code/error-codes.js';
import { getPersistenceRuntime } from '../../common/persistence/persistence-runtime.registry.js';
import { getBetterAuthSqlStore } from '../better-auth/core-better-auth-sql.registry.js';
import {
  type ISystemSetupHttpInitPolicy,
  isSystemSetupTokenValid,
  resolveSystemSetupHttpInit,
  SYSTEM_SETUP_TOKEN_HEADER,
} from './system-setup-http-init.helper.js';

/**
 * Collection holding the bootstrap claim marker on MongoDB — the 12.0.0 document (`{ _id, claimedAt }`), kept so
 * an older replica in a rolling deploy claims the same marker (see `infrastructure-locks.ts`).
 *
 * Native collection access is intentional here: no Mongoose schema exists for it
 * (see docs/native-driver-security.md).
 */
const SETUP_LOCK_COLLECTION = SYSTEM_SETUP_LOCK_COLLECTION;

/**
 * How long an initial-admin claim may stand before another replica takes it over.
 *
 * Long enough that a slow but live creation is never stolen, short enough that a crashed
 * claimer does not lock the deployment out for good.
 */
const INITIAL_ADMIN_CLAIM_STALE_AFTER_MS = SYSTEM_SETUP_CLAIM_STALE_AFTER_MS;

/** How long after the claim goes stale the boot looks at an interrupted setup again (see scheduleInterruptedSetupRetry) */
const INTERRUPTED_SETUP_RETRY_MARGIN_MS = 5_000;

/** An initial admin a killed setup left behind, and whether its credential account is still missing */
interface IInterruptedInitialAdmin {
  iamUser: { email?: string; id: string; name?: string };
  linkCredential: boolean;
}

/**
 * Input for creating the initial admin user
 */
export interface SystemSetupInitInput {
  email: string;
  name?: string;
  password: string;
}

/**
 * Response for successful init
 */
export interface SystemSetupInitResult {
  email: string;
  message: string;
  success: boolean;
}

/**
 * Response for setup status check
 */
export interface SystemSetupStatus {
  betterAuthEnabled: boolean;

  /**
   * Whether `POST /system-setup/init` is open in this environment (`systemSetup.httpInit`; by default only in
   * `local`, `ci` and `e2e`). Independent of `needsSetup`: a frontend offers the setup form only when both are true.
   *
   * @since 12.4.0
   */
  httpInitEnabled: boolean;

  /**
   * Whether the init must carry the setup token in the `X-System-Setup-Token` header. Only ever true together with
   * `httpInitEnabled`.
   *
   * @since 12.4.0
   */
  httpInitTokenRequired: boolean;

  needsSetup: boolean;
}

/**
 * CoreSystemSetupService provides initial admin creation for fresh deployments.
 *
 * This service allows creating the first admin user when the system has zero users.
 * It bypasses BetterAuth's disableSignUp check by using the internal adapter directly,
 * which is the same approach used by Better-Auth's own admin plugin.
 *
 * Security:
 * - The anonymous HTTP init is open only where `systemSetup.httpInit` allows it — by default only in `local`, `ci`
 *   and `e2e` ({@link assertHttpInitAllowed}); a deployment provisions its first admin via `initialAdmin` instead
 * - Only works when zero users exist in the database
 * - Once any user exists, the init endpoint is permanently locked
 * - Race conditions handled by an atomic claim shared by both entry points
 * - A creation that fails after the user was created removes that user again, so `needsSetup` stays true
 * - The admin role is written together with the user, and a setup that was killed halfway (no rollback ran) is
 *   finished at the next boot for the address `initialAdmin` names ({@link resumeInterruptedInitialAdmin})
 */
@Injectable()
export class CoreSystemSetupService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CoreSystemSetupService.name);

  /** The one planned retry of an interrupted setup whose claim was still held (see scheduleInterruptedSetupRetry) */
  private interruptedSetupRetry?: ReturnType<typeof setTimeout>;

  /** Who holds the claim: one owner per instance, so a second concurrent claim of the same process is refused too */
  private readonly claimOwner = `${hostname()}:${process.pid}:${randomUUID()}`;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly betterAuthService: CoreBetterAuthService,
    private readonly userMapper: CoreBetterAuthUserMapper,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Automatically create the initial admin on server start if configured via
   * `systemSetup.initialAdmin` in config or ENV variables.
   *
   * Uses OnApplicationBootstrap (not OnModuleInit) to ensure BetterAuth
   * is fully initialized before attempting user creation.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.createInitialAdminFromConfig();
    await this.reportSetupReachability();
  }

  /** Cancel a planned retry of an interrupted setup, so a closing application leaves no timer behind */
  onApplicationShutdown(): void {
    clearTimeout(this.interruptedSetupRetry);
    this.interruptedSetupRetry = undefined;
  }

  /**
   * Create the initial admin from `systemSetup.initialAdmin` when zero users exist (the boot half of
   * {@link onApplicationBootstrap}). Not gated by `systemSetup.httpInit`: it is the deployment's own configuration,
   * not an anonymous request.
   */
  protected async createInitialAdminFromConfig(): Promise<void> {
    const initialAdmin = this.usableInitialAdmin({ warn: true });
    if (!initialAdmin) {
      return;
    }

    const status = await this.getSetupStatus();
    if (!status.needsSetup) {
      // Users exist. One of them may be the initial admin of a setup that was killed halfway (SIGKILL, OOM): no
      // rollback ran, so it has no login account or no admin role, and the setup refuses from now on. Finish it.
      if (status.betterAuthEnabled && (await this.resumeInterruptedInitialAdmin(initialAdmin)) === 'claimed') {
        this.scheduleInterruptedSetupRetry(initialAdmin);
      }
      return;
    }

    if (!status.betterAuthEnabled) {
      this.logger.warn('Initial admin auto-creation skipped: BetterAuth not enabled');
      return;
    }

    // The atomic claim lives in createInitialAdmin() so that BOTH entry points — this
    // one and the anonymous POST /system-setup/init — serialize on the same marker.
    // Claiming here as well would take the claim twice on this path and leave the
    // public path unguarded.
    try {
      const result = await this.createInitialAdmin({
        email: initialAdmin.email,
        name: initialAdmin.name,
        password: initialAdmin.password,
      });
      this.logger.log(`Auto-created initial admin on startup: ${result.email}`);
    } catch (error) {
      // The claim is released by createInitialAdmin() itself, which is the only place
      // that takes it — so a replica that crashed mid-creation cannot block setup on
      // every future boot, and the marker has exactly one owner.
      if (error instanceof ForbiddenException) {
        this.logger.log('Initial admin auto-creation skipped (users already exist or claimed elsewhere)');
      } else {
        this.logger.warn(
          `Initial admin auto-creation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    }
  }

  /**
   * The configured `systemSetup.initialAdmin`, or `undefined` when it is absent or cannot be used.
   *
   * With `warn`, each reason it cannot be used is logged (the boot path); without, it only answers.
   */
  protected usableInitialAdmin(options?: { warn?: boolean }): ISystemSetupInitialAdmin | undefined {
    const initialAdmin = this.configService.configFastButReadOnly?.systemSetup?.initialAdmin;
    const skip = (message: string): undefined => {
      if (options?.warn) {
        this.logger.warn(message);
      }
      return undefined;
    };

    // No initialAdmin config at all → nothing to report here
    if (!initialAdmin) {
      return undefined;
    }

    // Partial credentials → skip
    if (!initialAdmin.email || !initialAdmin.password) {
      const missing = [!initialAdmin.email && 'email', !initialAdmin.password && 'password'].filter(Boolean).join(', ');
      return skip(`Incomplete initialAdmin config - missing: ${missing}. Auto-creation skipped.`);
    }

    // Validate email format (same validator as @IsEmail() decorator)
    if (!isEmail(initialAdmin.email)) {
      return skip(`Invalid initialAdmin email format: "${initialAdmin.email}". Auto-creation skipped.`);
    }

    // An all-digit NSC__SYSTEM_SETUP__INITIAL_ADMIN__PASSWORD arrives as a NUMBER (getEnvironmentObject() converts
    // numeric strings), and `.trim()` on it used to throw at boot. Name the cause instead.
    if (typeof initialAdmin.password !== 'string') {
      return skip(
        `initialAdmin password is a ${typeof initialAdmin.password}, not a string (an all-digit ENV value is ` +
          'converted to a number). Auto-creation skipped.',
      );
    }

    // Validate password is not empty/whitespace
    if (!initialAdmin.password.trim()) {
      return skip('Empty initialAdmin password. Auto-creation skipped.');
    }

    return initialAdmin;
  }

  /**
   * The environment the HTTP-init policy is decided for: the configured `env`, else `NODE_ENV`
   */
  protected currentEnv(): string | undefined {
    return this.configService.configFastButReadOnly?.env ?? process.env.NODE_ENV;
  }

  /**
   * Whether the anonymous `POST /system-setup/init` is open here, and whether it needs the setup token
   * (`systemSetup.httpInit`, see {@link resolveSystemSetupHttpInit}).
   */
  getHttpInitPolicy(): ISystemSetupHttpInitPolicy {
    return resolveSystemSetupHttpInit(
      this.configService.configFastButReadOnly?.systemSetup?.httpInit,
      this.currentEnv(),
    );
  }

  /**
   * Refuse an HTTP init the configuration does not allow — call it from every HTTP entry point before
   * {@link createInitialAdmin}, which does not check it (the boot path must not be gated).
   *
   * @param token the value of the `X-System-Setup-Token` header
   * @throws ForbiddenException `SYSTEM_SETUP_HTTP_INIT_DISABLED` when the HTTP init is closed in this environment,
   *   `SYSTEM_SETUP_TOKEN_INVALID` when it needs a token and `token` is missing or wrong
   */
  assertHttpInitAllowed(token?: unknown): void {
    const policy = this.getHttpInitPolicy();
    if (!policy.enabled) {
      throw new ForbiddenException(ErrorCode.SYSTEM_SETUP_HTTP_INIT_DISABLED);
    }
    if (policy.tokenRequired && !isSystemSetupTokenValid(policy.token, token)) {
      throw new ForbiddenException(ErrorCode.SYSTEM_SETUP_TOKEN_INVALID);
    }
  }

  /**
   * Say at boot when a deployment has no way to its first admin, or an open one (the second half of
   * {@link onApplicationBootstrap}).
   *
   * A deployed environment with zero users, no usable `initialAdmin` and a closed HTTP init cannot be set up at all:
   * nobody notices until somebody tries to sign in. With the HTTP init open WITHOUT a token, whoever reaches the API
   * first becomes the administrator. Both are logged; neither stops the boot. Local environments are left alone,
   * and an instance with a usable `initialAdmin` reports through the auto-creation instead — reporting here as well
   * would raise a false alarm on every replica that lost the creation race while the winner is still creating.
   */
  protected async reportSetupReachability(): Promise<void> {
    const policy = this.getHttpInitPolicy();
    if (policy.problem) {
      this.logger.error(
        `POST /system-setup/init stays closed: ${policy.problem}. Set a token of at least 16 characters ` +
          '(NSC__SYSTEM_SETUP__HTTP_INIT__TOKEN), or systemSetup.httpInit: true to open it without one.',
      );
    }
    this.warnAboutIgnoredEnvironmentNames();

    if (isLocalEnv(this.currentEnv()) || this.usableInitialAdmin() || (policy.enabled && policy.tokenRequired)) {
      return;
    }

    let needsSetup: boolean;
    try {
      needsSetup = (await this.getSetupStatus()).needsSetup;
    } catch (error) {
      // A diagnostic must never be the reason a boot fails
      this.logger.warn(
        `Could not check whether initial setup is needed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return;
    }
    if (!needsSetup) {
      return;
    }

    const env = this.currentEnv() ?? '(not set)';
    if (!policy.enabled) {
      this.logger.error(
        `No users exist and this instance cannot be set up: environment "${env}" closes POST /system-setup/init, ` +
          'and no initialAdmin is configured. Set NSC__SYSTEM_SETUP__INITIAL_ADMIN__EMAIL and ' +
          'NSC__SYSTEM_SETUP__INITIAL_ADMIN__PASSWORD (created on the next start), or open the HTTP init explicitly ' +
          'with NSC__SYSTEM_SETUP__HTTP_INIT__TOKEN=<secret of at least 16 characters> ' +
          `(sent as the "${SYSTEM_SETUP_TOKEN_HEADER}" header).`,
      );
      return;
    }
    this.logger.warn(
      `No users exist and POST /system-setup/init is open without a token in environment "${env}": whoever reaches ` +
        'the API first becomes the administrator. Prefer NSC__SYSTEM_SETUP__INITIAL_ADMIN__EMAIL / __PASSWORD, or ' +
        'protect the init with NSC__SYSTEM_SETUP__HTTP_INIT__TOKEN.',
    );
  }

  /**
   * Warn about `NSC__` variables for `systemSetup` that carry a camelCase segment (`NSC__systemSetup__initialAdmin__email`).
   *
   * `getEnvironmentObject()` lowercases every segment it does not split at `_`, so such a variable lands under
   * `systemsetup.initialadmin` — a key nothing reads — and the auto-creation silently never happens. The framework's
   * own documentation spelled the variables that way until 12.4.0. Only the variable NAMES are logged, never values.
   */
  protected warnAboutIgnoredEnvironmentNames(): void {
    for (const key of Object.keys(process.env)) {
      if (!key.startsWith('NSC__')) {
        continue;
      }
      const segments = key.slice('NSC__'.length).split('__');
      if (
        segments[0]?.replace(/_/g, '').toLowerCase() !== 'systemsetup' ||
        !segments.some((s) => /[a-z][A-Z]/.test(s))
      ) {
        continue;
      }
      const corrected = `NSC__${segments.map((s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()).join('__')}`;
      this.logger.warn(`Environment variable ${key} is not read (camelCase segment). Use ${corrected} instead.`);
    }
  }

  /**
   * Try to claim the initial-admin creation for this instance
   *
   * A lease (`LockStore`), so exactly one of N concurrently booting replicas — or of N anonymous
   * `POST /system-setup/init` callers — wins the claim.
   *
   * @returns true when this instance may create the initial admin
   */
  protected async claimInitialAdminSetup(): Promise<boolean> {
    // The marker is a CLAIM, not a permanent record: a replica SIGKILLed between claiming and
    // creating (OOM, node drain, a failed first rollout — all ordinary) never reaches the
    // release in createInitialAdmin(). Without an expiry that leaves a deployment with zero users
    // and no way in, recoverable only by deleting a document from an undocumented collection.
    // A stale claim is therefore taken over rather than obeyed.
    const locks = await this.setupLocks();
    return locks.tryAcquire(SYSTEM_SETUP_LOCK_KEY, this.claimOwner, INITIAL_ADMIN_CLAIM_STALE_AFTER_MS / 1000);
  }

  /**
   * Remove the initial-admin claim marker so a later boot can retry the setup
   */
  protected async releaseInitialAdminSetupClaim(): Promise<void> {
    try {
      await (await this.setupLocks()).release(SYSTEM_SETUP_LOCK_KEY, this.claimOwner);
    } catch (error) {
      // Never mask the failure that triggered the release
      this.logger.warn(
        `Failed to release initial admin setup claim: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Everything the initial admin needs after its user exists: the credential account (unless it has one), the link
   * to the app user, the admin role, the legacy password. {@link createInitialAdmin} runs it for a new user,
   * {@link resumeInterruptedInitialAdmin} for one a killed setup left behind — so both finish the same way.
   *
   * Throws on the first failure; the caller decides what to undo.
   */
  protected async finishInitialAdmin(
    context: {
      internalAdapter: { linkAccount(account: Record<string, unknown>): Promise<unknown> };
      password: { hash(password: string): Promise<string> };
    },
    iamUser: { email?: string; id: string; name?: string },
    input: SystemSetupInitInput,
    normalizedPassword: string,
    options: { linkCredential: boolean },
  ): Promise<void> {
    if (options.linkCredential) {
      // Hash password and create credential account
      const hashedPassword = await context.password.hash(normalizedPassword);
      // better-auth 1.7.0–1.7.2 key accounts by (issuer, accountId) and require the issuer;
      // credential accounts carry a synthetic one, always derived via the helper, never a
      // hand-written literal. better-auth 1.7.3+ went back to (providerId, accountId) and knows no
      // issuer field, so the helper answers `undefined` there and nothing is written.
      //
      // The parameter type above is structural, so a vendored core compiled against better-auth 1.7.0–1.7.2 (whose
      // own type requires `issuer`, which a conditional spread reads as optional) builds as well.
      const credentialIssuer = legacyCredentialAccountIssuer();
      await context.internalAdapter.linkAccount({
        accountId: iamUser.id,
        ...(credentialIssuer ? { issuer: credentialIssuer } : {}),
        password: hashedPassword,
        providerId: 'credential',
        userId: iamUser.id,
      });
    }

    // Sync to nest-server users collection
    const syncedUser = await this.userMapper.linkOrCreateUser({
      email: iamUser.email,
      emailVerified: true,
      id: iamUser.id,
      name: iamUser.name,
    });

    if (!syncedUser) {
      throw new Error('Failed to sync user to nest-server collection');
    }

    // Set admin role directly — the framework's own decision, as system work. createUser already wrote it for a new
    // user; this write is what gives it to the leftover of an older setup, and keeps it when the sync touched the row.
    const sql = getBetterAuthSqlStore();
    if (sql) {
      await sql.updateUserAsSystem(String(syncedUser._id), { roles: [RoleEnum.ADMIN] });
    } else {
      await this.connection
        .collection('users')
        .updateOne({ _id: syncedUser._id }, { $set: { roles: [RoleEnum.ADMIN], updatedAt: new Date() } });
    }

    // Sync password to Legacy Auth for backwards compatibility
    await this.userMapper.syncPasswordToLegacy(iamUser.id, input.email, input.password);
  }

  /**
   * Whether any user holds the admin role, wherever the `users` table lives (see {@link countUsers})
   */
  protected async hasAdmin(): Promise<boolean> {
    const store = getBetterAuthSqlStore()?.users ?? (await getPersistenceRuntime()?.iamStorage())?.users;
    const admins = store
      ? await store.count({ roles: RoleEnum.ADMIN })
      : await this.connection.collection('users').countDocuments({ roles: RoleEnum.ADMIN });
    return admins > 0;
  }

  /**
   * The initial admin a killed setup left behind for `email`, or `undefined` when the user with that address is
   * anything else. A user qualifies only where nothing but the setup can have produced its state:
   *
   * - an administrator without any account: killed between createUser (which writes the role) and linkAccount;
   * - no administrator in the system, and the user has no account: the same, from a setup before the role moved into
   *   createUser;
   * - no administrator in the system, and the user's only account is a credential account with the configured
   *   password: killed between linkAccount and the role update of such a setup. The password is the evidence — a
   *   user who signed up with the administrator's address has a password of their own.
   *
   * A social account, a second account, another password or a legacy password ({@link hasLegacyPassword}) never
   * qualifies, and a finished setup (administrator with an account) is answered without comparing the password.
   */
  protected async findInterruptedInitialAdmin(
    context: {
      internalAdapter: {
        findUserByEmail(
          email: string,
          options: { includeAccounts: boolean },
        ): Promise<null | {
          accounts: Array<{ password?: null | string; providerId: string }>;
          user: { email?: string; id: string; name?: string; roles?: unknown };
        }>;
      };
      password: { verify(data: { hash: string; password: string }): Promise<boolean> };
    },
    email: string,
    normalizedPassword: string,
  ): Promise<IInterruptedInitialAdmin | undefined> {
    const found = await context.internalAdapter.findUserByEmail(email, { includeAccounts: true });
    if (!found?.user) {
      return undefined;
    }
    const isAdmin = Array.isArray(found.user.roles) && found.user.roles.includes(RoleEnum.ADMIN);
    const accounts = found.accounts ?? [];

    if (accounts.length === 0) {
      if (!isAdmin && (await this.hasAdmin())) {
        return undefined;
      }
      return (await this.hasLegacyPassword(found.user, email))
        ? undefined
        : { iamUser: found.user, linkCredential: true };
    }

    if (isAdmin || accounts.length !== 1) {
      return undefined;
    }
    const [account] = accounts;
    if (account.providerId !== 'credential' || !account.password) {
      return undefined;
    }
    if (!(await context.password.verify({ hash: account.password, password: normalizedPassword }))) {
      return undefined;
    }
    if (await this.hasAdmin()) {
      return undefined;
    }
    return (await this.hasLegacyPassword(found.user, email))
      ? undefined
      : { iamUser: found.user, linkCredential: false };
  }

  /**
   * Whether the app user behind `iamUser` carries a legacy password (`users.password`). A killed setup never has one:
   * syncing it is the last step of {@link finishInitialAdmin}, and neither createUser nor the sync writes it. So a user
   * with one did not come from the setup — typically a Legacy-Auth administrator who has not signed in through IAM
   * yet, who has no Better-Auth account either. Finishing such a user would replace their own password with the
   * configured one.
   */
  protected async hasLegacyPassword(iamUser: { email?: string; id: string }, email: string): Promise<boolean> {
    const store = getBetterAuthSqlStore()?.users ?? (await getPersistenceRuntime()?.iamStorage())?.users;
    const row = store
      ? await store.findById(iamUser.id, { select: ['password'] })
      : await this.connection
          .collection('users')
          .findOne({ email: iamUser.email ?? email }, { projection: { password: 1 } });
    return typeof row?.password === 'string' && row.password.length > 0;
  }

  /**
   * Finish the initial admin a killed setup left behind (see {@link findInterruptedInitialAdmin}) for the address and
   * password `systemSetup.initialAdmin` configures — the boot path only. The anonymous `POST /system-setup/init` never
   * gets here: once users exist it refuses, as before, because finishing would set a password on an existing account.
   *
   * Runs under the same claim as {@link createInitialAdmin}, so of N booting replicas one finishes it. Never throws: a
   * failure is logged and the user is kept (it existed before this call), so the next boot can try again.
   *
   * @returns `'claimed'` when the claim is held (by the killed attempt, until it goes stale), `'none'` when there is
   *   nothing to finish
   */
  protected async resumeInterruptedInitialAdmin(
    initialAdmin: ISystemSetupInitialAdmin,
  ): Promise<'claimed' | 'done' | 'failed' | 'none'> {
    const authInstance = this.betterAuthService.getInstance();
    if (!authInstance) {
      return 'none';
    }
    const input: SystemSetupInitInput = {
      email: initialAdmin.email,
      name: initialAdmin.name,
      password: initialAdmin.password,
    };
    let claimed = false;
    try {
      const context = await authInstance.$context;
      const normalizedPassword = this.userMapper.normalizePasswordForIam(input.password);
      if (!(await this.findInterruptedInitialAdmin(context, input.email, normalizedPassword))) {
        return 'none';
      }
      if (!(await this.claimInitialAdminSetup())) {
        return 'claimed';
      }
      claimed = true;

      // Look again under the claim: another replica may have finished it in between
      const interrupted = await this.findInterruptedInitialAdmin(context, input.email, normalizedPassword);
      if (!interrupted) {
        await this.releaseInitialAdminSetupClaim();
        return 'none';
      }
      await this.finishInitialAdmin(context, interrupted.iamUser, input, normalizedPassword, {
        linkCredential: interrupted.linkCredential,
      });
      this.logger.warn(
        `Finished an interrupted initial-admin setup for ${input.email}: the previous attempt was stopped before ` +
          `it completed (${interrupted.linkCredential ? 'no login account' : 'no admin role'}).`,
      );
      return 'done';
    } catch (error) {
      if (claimed) {
        await this.releaseInitialAdminSetupClaim();
      }
      this.logger.error(
        `Finishing the interrupted initial-admin setup for ${input.email} failed ` +
          `(${error instanceof Error ? error.message : 'Unknown error'}); the next start tries again.`,
      );
      return 'failed';
    }
  }

  /**
   * Try an interrupted setup once more after the claim of the killed attempt has gone stale. A process restarted
   * within that window (the usual case after an OOM kill) finds the claim held, and without this retry the deployment
   * would stay without a way in until the next deploy. One retry, cancelled at shutdown.
   */
  protected scheduleInterruptedSetupRetry(initialAdmin: ISystemSetupInitialAdmin): void {
    const delayMs = INITIAL_ADMIN_CLAIM_STALE_AFTER_MS + INTERRUPTED_SETUP_RETRY_MARGIN_MS;
    this.logger.warn(
      `An interrupted initial-admin setup for ${initialAdmin.email} was found, but the claim of the previous attempt ` +
        `is still held; trying again in ${Math.ceil(delayMs / 60_000)} minutes.`,
    );
    clearTimeout(this.interruptedSetupRetry);
    this.interruptedSetupRetry = setTimeout(() => {
      this.interruptedSetupRetry = undefined;
      // Cannot reject: retryInterruptedInitialAdmin() catches everything it awaits.
      void this.retryInterruptedInitialAdmin(initialAdmin);
    }, delayMs);
    this.interruptedSetupRetry.unref?.();
  }

  /** The retry {@link scheduleInterruptedSetupRetry} planned; names how to clear the claim when it is still held */
  protected async retryInterruptedInitialAdmin(initialAdmin: ISystemSetupInitialAdmin): Promise<void> {
    try {
      if ((await this.resumeInterruptedInitialAdmin(initialAdmin)) === 'claimed') {
        const claim = await this.setupClaimLocation();
        this.logger.error(
          `The interrupted initial-admin setup for ${initialAdmin.email} is still blocked by the claim in ` +
            `${claim.where}. If no other instance is setting up, ${claim.remedy} and restart.`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Retrying the interrupted initial-admin setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Remove the user a failed {@link createInitialAdmin} had already created: Better-Auth's sessions and accounts and
   * the `users` row, which Better-Auth and the user model share. Without it the deployment keeps a user without the
   * admin role, `needsSetup` turns false and init stays refused for good.
   *
   * Never throws: the failure that triggered the rollback is the one the caller must see. A rollback that fails is
   * logged with what to remove by hand.
   */
  protected async rollbackInitialAdmin(
    context: { internalAdapter: { deleteUser(userId: string): Promise<unknown> } },
    iamUserId: string,
    email: string,
  ): Promise<void> {
    try {
      await context.internalAdapter.deleteUser(iamUserId);
      this.logger.warn(`Initial admin creation failed; the partially created user ${email} was removed again`);
    } catch (error) {
      this.logger.error(
        `Initial admin creation failed and the partially created user ${email} could not be removed ` +
          `(${error instanceof Error ? error.message : 'Unknown error'}). Remove that user and its accounts from ` +
          '"users" and "account", otherwise initial setup stays refused because a user exists.',
      );
    }
  }

  /**
   * Where the claim lives: the lease table when the default data source is a SQL database, else the MongoDB marker
   */
  protected async setupLocks(): Promise<LockStore> {
    return (
      (await defaultSqlLockStore('system-setup')) ??
      systemSetupMongoLocks(this.connection.collection(SETUP_LOCK_COLLECTION) as unknown as Collection<any>)
    );
  }

  /**
   * Where the claim lives, in the words an operator needs to clear it: the lease row on a SQL default source, the
   * marker collection on MongoDB. The refusal log names it, so it must name the store `setupLocks()` actually uses.
   */
  protected async setupClaimLocation(): Promise<{ remedy: string; where: string }> {
    if (await defaultSqlLockStore('system-setup')) {
      const row = `system-setup:${SYSTEM_SETUP_LOCK_KEY}`;
      return { remedy: `delete the row "${row}" from "lt_locks"`, where: `"lt_locks" (row "${row}")` };
    }
    return { remedy: `drop "${SETUP_LOCK_COLLECTION}"`, where: `"${SETUP_LOCK_COLLECTION}"` };
  }

  /**
   * How many users exist, wherever the `users` table lives: a user model on a SQL source is counted there — counting the
   * MongoDB collection instead would find none and let an anonymous caller create an administrator
   */
  protected async countUsers(): Promise<number> {
    const users = getBetterAuthSqlStore()?.users ?? (await getPersistenceRuntime()?.iamStorage())?.users;
    return users ? users.count({}) : this.connection.collection('users').countDocuments({});
  }

  /**
   * Check if the system needs initial setup (zero users)
   */
  async getSetupStatus(): Promise<SystemSetupStatus> {
    const userCount = await this.countUsers();
    const httpInit = this.getHttpInitPolicy();
    return {
      betterAuthEnabled: this.betterAuthService.isEnabled(),
      httpInitEnabled: httpInit.enabled,
      httpInitTokenRequired: httpInit.enabled && httpInit.tokenRequired,
      needsSetup: userCount === 0,
    };
  }

  /**
   * Create the initial admin user when zero users exist.
   *
   * Uses BetterAuth's internalAdapter to bypass disableSignUp,
   * then syncs to nest-server users collection with admin role.
   *
   * Does NOT check `systemSetup.httpInit`: the boot path calls it too. An HTTP entry point calls
   * {@link assertHttpInitAllowed} first, as `CoreSystemSetupController` does.
   */
  async createInitialAdmin(input: SystemSetupInitInput): Promise<SystemSetupInitResult> {
    // Pre-check: only allow when zero users exist
    const userCount = await this.countUsers();
    if (userCount > 0) {
      throw new ForbiddenException(ErrorCode.SYSTEM_SETUP_NOT_AVAILABLE);
    }

    // Ensure BetterAuth is enabled
    if (!this.betterAuthService.isEnabled()) {
      throw new ForbiddenException(ErrorCode.SYSTEM_SETUP_BETTERAUTH_REQUIRED);
    }

    const authInstance = this.betterAuthService.getInstance();
    if (!authInstance) {
      throw new ForbiddenException(ErrorCode.SYSTEM_SETUP_BETTERAUTH_REQUIRED);
    }

    // The count check above is check-then-act, and this method is reachable ANONYMOUSLY
    // via POST /system-setup/init. Two concurrent callers with DIFFERENT emails both pass
    // it and both get an admin — the E11000 handler below only catches the same-email
    // case. The claim is the same marker the boot path uses, so the HTTP path and the
    // auto-bootstrap also serialize against each other instead of racing: an attacker
    // racing a fresh deployment can no longer obtain an admin account ALONGSIDE the
    // configured one.
    if (!(await this.claimInitialAdminSetup())) {
      // Say WHICH guard refused. This one and the user-count guard above share
      // ErrorCode.SYSTEM_SETUP_NOT_AVAILABLE, and the response cannot tell them apart — so
      // without this line a caller that just emptied `users` is told users exist while the
      // collection is empty. That is a genuinely expensive thing to diagnose from the outside:
      // the marker outlives a SUCCESSFUL setup (it is released only on failure), so the usual
      // "reset the database" reflex does not clear it.
      // `log`, not `warn`. Both entry points reach this line, and for one of them a refusal is
      // the EXPECTED outcome: on a multi-replica fresh rollout every replica but one loses the
      // claim race, so `warn` would fire N-1 times per normal deployment — each time immediately
      // followed by onApplicationBootstrap's own INFO line calling the same event a normal skip.
      // Two records with contradictory severity for one non-event trains operators to ignore the
      // louder one. The HTTP caller is not left without a diagnosis: the message is unchanged and
      // an operator investigating a 403 reads it at the default level.
      const claim = await this.setupClaimLocation();
      this.logger.log(
        `System setup refused: the initial-admin claim in ${claim.where} is held. ` +
          'Either another instance is running the setup right now, or a previous SUCCESSFUL setup ' +
          'left the marker behind — it is removed only when creation FAILS. If you reset the ' +
          `database to replay the setup, ${claim.remedy} alongside "users"; ` +
          `otherwise setup stays refused until the claim goes stale after ` +
          `${INITIAL_ADMIN_CLAIM_STALE_AFTER_MS / 60_000} minutes.`,
      );
      throw new ForbiddenException(ErrorCode.SYSTEM_SETUP_NOT_AVAILABLE);
    }

    // Set once the IAM user exists: every failure after that point removes the user again (see the catch below)
    let createdIamUserId: string | undefined;
    let context: Awaited<typeof authInstance.$context> | undefined;
    try {
      // Access BetterAuth internal context (same pattern as core-better-auth-api.middleware.ts)
      context = await authInstance.$context;

      // Normalize password for IAM (SHA256 if plain text)
      const normalizedPassword = this.userMapper.normalizePasswordForIam(input.password);

      // Create user via internalAdapter (bypasses disableSignUp)
      //
      // better-auth >= 1.7 requires a provisioning source. Without it, `createUser` throws
      // FORBIDDEN/validation_source_missing as soon as a project configures
      // `betterAuth.options.user.validateUserInfo`. `admin` is the honest value — the system
      // provisions the FIRST admin, nobody signs up — and it is what better-auth's own admin
      // plugin passes.
      //
      // This does NOT bypass `validateUserInfo`. The hook still runs and receives
      // `{ method: 'admin', action: 'create-user' }`, so a project gate can still reject the
      // initial admin; branch on `method` there if the setup should be exempt.
      //
      // KNOWN LIMITATION, and the reason this is spelled out: when `validateUserInfo` is
      // configured, better-auth additionally calls `getCurrentAuthContext()`, which throws outside
      // an endpoint context. System setup runs from `OnApplicationBootstrap` / a plain controller,
      // never inside better-auth's request pipeline, so the call fails with
      // FORBIDDEN/validation_context_missing and no initial admin is created. Fail-closed, but
      // opaque. A project using that hook must provision the first admin another way — see
      // migration-guides/11.36.x-to-11.37.0.md §7.
      //
      // The admin role is part of this write (`roles` is a Better-Auth field of the shared users row; `input: false`
      // binds only the API, not the internal adapter). Written in a separate step after it, a process killed in
      // between (SIGKILL, OOM) left a user without the role: users existed, `needsSetup` was false, and the
      // deployment had no administrator and no way to one. Now the worst a killed setup leaves is an administrator
      // without a login account, which the next boot finishes (resumeInterruptedInitialAdmin).
      const iamUser = await context.internalAdapter.createUser(
        {
          email: input.email,
          emailVerified: true,
          name: input.name || input.email.split('@')[0],
          roles: [RoleEnum.ADMIN],
        },
        { method: 'admin' },
      );

      if (!iamUser) {
        throw new Error('Failed to create IAM user');
      }
      createdIamUserId = iamUser.id;

      await this.finishInitialAdmin(context, iamUser, input, normalizedPassword, { linkCredential: true });

      this.logger.log(`Initial admin user created: ${input.email}`);

      return {
        email: input.email,
        message: 'Initial admin user created successfully',
        success: true,
      };
    } catch (error) {
      // Remove the user this call created BEFORE releasing the claim. A failure after createUser (linkAccount,
      // the sync, the role update, the legacy password) otherwise left a user without the admin role — and from then
      // on `needsSetup` is false and init refused, so the deployment had users but no administrator and no way back
      // short of editing the database. Seen on a deployed stage when linkAccount threw.
      if (createdIamUserId && context) {
        await this.rollbackInitialAdmin(context, createdIamUserId, input.email);
      }

      // Release the claim we took above: a caller that failed mid-creation must not
      // leave a deployment with zero users and no way in. The marker is additionally
      // stale-expiring, so this is belt AND braces for the crash-before-release case.
      await this.releaseInitialAdminSetupClaim();

      // Handle duplicate email (race condition via MongoDB unique index)
      if (error instanceof Error && (error.message?.includes('duplicate key') || error.message?.includes('E11000'))) {
        throw new ForbiddenException(ErrorCode.SYSTEM_SETUP_NOT_AVAILABLE);
      }

      // Re-throw known exceptions
      if (error instanceof ForbiddenException) {
        throw error;
      }

      this.logger.error(`System setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw new ForbiddenException(ErrorCode.SYSTEM_SETUP_NOT_AVAILABLE);
    }
  }
}
