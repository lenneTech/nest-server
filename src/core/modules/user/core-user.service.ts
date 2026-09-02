import { BadRequestException, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import bcrypt = require('bcrypt');
import crypto = require('crypto');
import { sha256 } from 'js-sha256';
import { Document, Model } from 'mongoose';

import { looksLikeSystemRole, SYSTEM_ROLE_PREFIX } from '../../common/enums/role.enum';
import { resolveAppUrlFromConfig } from '../../common/helpers/cookies.helper';
import { maskEmail } from '../../common/helpers/logging.helper';
import { assignPlain, isQueryableString, prepareServiceOptionsForCreate } from '../../common/helpers/input.helper';
import { ServiceOptions } from '../../common/interfaces/service-options.interface';
import { ConfigService } from '../../common/services/config.service';
import { CrudService } from '../../common/services/crud.service';
import { ErrorCode } from '../error-code/error-codes';
import { EmailService } from '../../common/services/email.service';
import { CoreModelConstructor } from '../../common/types/core-model-constructor.type';
import { CoreUserModel } from './core-user.model';
import { CoreUserCreateInput } from './inputs/core-user-create.input';
import { CoreUserInput } from './inputs/core-user.input';
import { CoreUserServiceOptions } from './interfaces/core-user-service-options.interface';

/**
 * User service
 *
 * Provides user management with automatic synchronization between
 * Legacy Auth and Better-Auth (IAM) systems when both are enabled.
 */
/**
 * Default lifetime of a legacy password-reset token, in minutes.
 *
 * One hour, matching Better-Auth's `resetPasswordTokenExpiresIn` — the half of this framework that
 * already had an expiry. Before 11.38.0 the legacy half had none at all.
 */
const DEFAULT_PASSWORD_RESET_TOKEN_EXPIRY_MINUTES = 60;

export abstract class CoreUserService<
  TUser extends CoreUserModel,
  TUserInput extends CoreUserInput,
  TUserCreateInput extends CoreUserCreateInput,
> extends CrudService<TUser, TUserCreateInput, TUserInput> {
  protected readonly userServiceLogger = new Logger(CoreUserService.name);

  protected constructor(
    protected override readonly configService: ConfigService,
    protected readonly emailService: EmailService,
    protected override readonly mainDbModel: Model<Document & TUser>,
    protected override readonly mainModelConstructor: CoreModelConstructor<TUser>,
    /**
     * Optional configuration for additional features like IAM sync.
     * Using options object pattern for extensibility without breaking changes.
     */
    protected readonly options?: CoreUserServiceOptions,
  ) {
    super();
    this.warnOnAmbiguousResetLinkConvention();
  }

  /**
   * Warn once at boot when `email.passwordResetLink` is set WITHOUT a `{token}` placeholder.
   *
   * Two conventions live side by side in this flow, and which one applies depends on something
   * nobody would guess: whether the option is present at all.
   *
   *   not set                                     → `<appUrl>/auth/reset-password?token=<token>`
   *   set to `<appUrl>/auth/reset-password`       → `<appUrl>/auth/reset-password/<token>`
   *
   * Same string, same intent, different link. Writing the default out by hand — to make it
   * overridable per environment, or to derive it from `appUrl` — silently selects the OTHER
   * convention. The mail still arrives, still looks right, and fails only for whoever clicks it:
   * the exact failure mode this whole area was repaired for.
   *
   * The path-segment rule is kept regardless, because a project that already configures such a
   * value has a page built for it, and moving it to `?token=` would break that page. So the fix
   * cannot be to change the behaviour — it has to be to make it visible.
   *
   * Adding `{token}` explicitly silences this warning AND records the intent in the config, which
   * is why that is the remedy named in the message rather than "ignore this if deliberate".
   *
   * The message also names a PRECONDITION for that remedy, and it is load-bearing: `{token}` is
   * substituted by `buildPasswordResetLink()` and by nothing else. A project whose
   * `sendPasswordResetMail()` still concatenates the link by hand — i.e. precisely the projects
   * this warning is aimed at — would follow the advice and mail `/reset-password/{token}/<token>`.
   * That is the same failure this whole area was repaired for: a mail that arrives, looks right,
   * and fails only for whoever clicks it. Advice that is correct for half its audience and
   * silently harmful to the other half is worse than none, so the ORDER of the two steps belongs
   * in the message rather than in a doc the reader may never reach.
   */
  protected warnOnAmbiguousResetLinkConvention(): void {
    const configured = this.configService.getFastButReadOnly<string>('email.passwordResetLink');

    if (typeof configured !== 'string' || !configured.trim().length || configured.includes('{token}')) {
      return;
    }

    this.userServiceLogger.warn(
      `email.passwordResetLink is set without a {token} placeholder ("${configured.trim()}"), so the token is ` +
        'appended as a PATH segment. Leaving the option unset would instead produce "?token=", the shape the ' +
        'reset page shipped by nuxt-base-starter reads. Both are supported — add {token} where your page ' +
        'expects it (".../reset-password/{token}" or ".../reset-password?token={token}") to state which, and ' +
        'to silence this warning. FIRST make sure the mail is built by ' +
        'CoreUserService.buildPasswordResetLink(): it is the only thing that substitutes {token}, so a ' +
        'sendPasswordResetMail() that still concatenates the link itself would mail the placeholder ' +
        'verbatim ("/reset-password/{token}/<token>").',
    );
  }

  // ===================================================================================================================
  // Methods
  // ===================================================================================================================

  /**
   * Create user
   */
  override async create(input: any, serviceOptions?: ServiceOptions): Promise<TUser> {
    serviceOptions = prepareServiceOptionsForCreate(serviceOptions);
    return this.process(
      async (data) => {
        // Application-level email-uniqueness check. The unique index alone is NOT
        // sufficient: on a FRESH database Mongoose builds indexes asynchronously
        // (autoIndex), so an early duplicate sign-up can slip through before the
        // index exists — observed as a load-dependent e2e flake, and the same
        // window exists on a freshly deployed production database. The index
        // remains the backstop for truly concurrent duplicate requests.
        if (data.input?.email) {
          const existing = await this.mainDbModel.findOne({ email: data.input.email }).lean().exec();
          if (existing) {
            throw new BadRequestException('Email address already in use');
          }
        }

        // Create user with verification token
        const currentUserId = serviceOptions?.currentUser?._id;
        const createdUser = new this.mainDbModel({
          ...data.input,
          createdBy: currentUserId,
          updatedBy: currentUserId,
          verificationToken: crypto.randomBytes(32).toString('hex'),
        });

        // Distinguish between different error messages when saving
        try {
          await createdUser.save();
        } catch (error) {
          if (error?.errors?.email?.kind === 'unique' || error?.code === 11000) {
            throw new BadRequestException('Email address already in use');
          } else {
            throw new UnprocessableEntityException();
          }
        }

        // Return created user
        return createdUser;
      },
      { input, serviceOptions },
    );
  }

  /**
   * Get user via email
   */
  async getViaEmail(email: string, serviceOptions?: ServiceOptions): Promise<TUser> {
    const dbObject = await this.mainDbModel.findOne({ email }).exec();
    if (!dbObject) {
      throw new NotFoundException(`No user found with email: ${email}`);
    }
    return this.process(async () => dbObject, { dbObject, serviceOptions });
  }

  /**
   * Get user by MongoDB ID or BetterAuth IAM ID
   *
   * This method is used by RolesGuard to resolve users from BetterAuth JWT tokens.
   * The sub claim in BetterAuth JWTs can contain either:
   * - The MongoDB _id of the user
   * - The BetterAuth iamId
   *
   * @param idOrIamId - MongoDB _id or BetterAuth iamId
   * @returns User object or null if not found
   */
  async getByIdOrIamId(idOrIamId: string): Promise<null | TUser> {
    try {
      // First, try to find by MongoDB _id
      const byId = await this.mainDbModel.findById(idOrIamId).exec();
      if (byId) {
        return byId as TUser;
      }
    } catch {
      // Invalid ObjectId format - try iamId instead
    }

    // Try to find by iamId
    const byIamId = await this.mainDbModel.findOne({ iamId: idOrIamId }).exec();
    return byIamId as null | TUser;
  }

  /**
   * Get verified state of user by token
   */
  async getVerifiedState(token: string, _serviceOptions?: ServiceOptions): Promise<boolean> {
    if (!isQueryableString(token)) {
      return false;
    }

    const user = await this.mainDbModel.findOne({ verificationToken: token }).exec();

    if (!user) {
      throw new NotFoundException(`No user found with verify token: ${token}`);
    }

    return user.verified;
  }

  /**
   * Verify user with token
   */
  async verify(token: string, serviceOptions?: ServiceOptions): Promise<string | TUser> {
    // Get user
    if (!isQueryableString(token)) {
      throw new NotFoundException(ErrorCode.INVALID_TOKEN);
    }

    const dbObject = await this.mainDbModel.findOne({ verificationToken: token }).exec();
    if (!dbObject) {
      throw new NotFoundException(`No user found with verify token: ${token}`);
    }

    if (!dbObject.verificationToken) {
      throw new BadRequestException('User has no verification token');
    }

    if (dbObject.verified) {
      return 'User already verified';
    }

    return this.process(
      async () => {
        // Update and return user
        await this.mainDbModel.updateOne({ _id: dbObject.id }, { verified: true, verifiedAt: new Date() }).exec();
        // Return the updated user
        return await this.mainDbModel.findById(dbObject.id).exec();
      },
      { dbObject, serviceOptions },
    );
  }

  /**
   * Set new password for user with token
   *
   * This method also syncs the password change to Better-Auth (IAM) if:
   * - BetterAuthUserMapper is configured via options
   * - User has an existing IAM credential account
   */
  async resetPassword(token: string, newPassword: string, serviceOptions?: ServiceOptions): Promise<TUser> {
    // Get user
    // A client-supplied value reaches here with its declared `string` type erased — see
    // `isQueryableString`. Without this, `{ $ne: null }` selects the first user holding ANY live
    // reset token and takes over that account without the attacker ever seeing the mail.
    if (!isQueryableString(token)) {
      throw new NotFoundException(ErrorCode.LINK_INVALID_OR_EXPIRED);
    }

    const dbObject = await this.mainDbModel.findOne({ passwordResetToken: token }).exec();

    // An EXPIRED token is answered exactly like an unknown one — same exception, same 404. The
    // distinction would tell a caller holding a stale token that it was once real and belongs to a
    // live account, which is precisely what a stolen mail archive wants confirmed.
    if (dbObject && this.isPasswordResetTokenExpired(dbObject.passwordResetTokenExpiresAt)) {
      // Burn it on sight rather than leaving it to be retried. It is worthless now, and a value
      // that stays in the row is one a later change could start honouring again.
      await this.mainDbModel
        // `$unset`, not `$set: null` — a null still counts as present, so it would keep an entry
        // in the partial index the token field carries and grow it by one per user who ever
        // requested a reset.
        .updateOne({ _id: dbObject._id }, { $unset: { passwordResetToken: 1, passwordResetTokenExpiresAt: 1 } })
        .exec();
      this.userServiceLogger.debug(`Rejected an expired password-reset token for ${maskEmail(dbObject.email)}`);
    }

    if (!dbObject || this.isPasswordResetTokenExpired(dbObject.passwordResetTokenExpiresAt)) {
      // The token is NOT echoed. It is attacker-supplied so nothing secret leaks, but it lands
      // in the response body and in every log line that records the exception — and this logger
      // feeds the ADMIN-readable Hub log buffer. An unbounded caller-controlled string there is
      // free log-stuffing, and the message is no more useful for it.
      throw new NotFoundException(ErrorCode.LINK_INVALID_OR_EXPIRED);
    }

    // Capture the submitted password for the IAM sync before the closure below
    // reassigns `newPassword` to its sha256 form.
    //
    // It is passed on exactly as received, INCLUDING an already-sha256-hashed
    // one. This used to skip the sync for a 64-hex value, on the reasoning that
    // "IAM uses scrypt, not bcrypt+sha256" — but the sync does not need a plain
    // password: `hashPasswordForBetterAuth` runs its input through
    // `normalizePasswordForIam`, which passes a 64-hex string through unchanged
    // by design, and `migrateAccountToIam` is fed the very same pre-hashed value
    // when an account is created.
    //
    // The guard therefore disabled the sync for exactly the clients this stack
    // ships. The lt frontends hash in the browser before sending — seven call
    // sites in `nuxt-extensions/src/runtime/lib/auth-client.ts` (`signIn.email`,
    // `resetPassword`, `changePassword` and the rest) run `ltSha256` on the
    // password first. That is independent of the `sha256` config option, which
    // only governs what the SERVER does with a plaintext password it happens to
    // receive. So the value arriving here is 64-hex whatever that option says,
    // and every such reset took the skipped branch.
    //
    // The legacy password was updated, the IAM credential was not, and sign-in —
    // which goes through IAM — kept accepting the OLD password and refusing the
    // new one. The endpoint reported success throughout, so the failure surfaced
    // only at the next sign-in.
    //
    // A client that posts a plaintext password was never affected: the old guard
    // let that one through, and the sync normalized it the same way IAM does.
    const passwordForIamSync = newPassword;

    return this.process(
      async () => {
        // Check if the password was transmitted encrypted
        // If not, the password is encrypted to enable future encrypted and unencrypted transmissions
        if (this.configService.configFastButReadOnly.sha256 && !/^[a-f0-9]{64}$/i.test(newPassword)) {
          newPassword = sha256(newPassword);
        }

        // Update Legacy Auth password
        const updatedUser = await assignPlain(dbObject, {
          password: await bcrypt.hash(newPassword, 10),
          passwordResetToken: null,
          passwordResetTokenExpiresAt: null,
          // A reset is what somebody reaches for after a suspected takeover, so it must not
          // leave the attacker's session live. Clearing the refresh tokens ends every legacy
          // session; the IAM half is `betterAuth.emailAndPassword.revokeSessionsOnPasswordReset`,
          // which is off by default because it is a behaviour change for existing deployments —
          // the migration guide recommends turning it on.
          //
          // Without this, "the reset now lands in both stores" would still leave the account
          // reachable with the credential the reset was meant to retire.
          refreshTokens: {},
        }).save();

        // Sync password to Better-Auth (IAM) if mapper is available
        // This ensures users can sign in via IAM after password reset
        if (this.options?.betterAuthUserMapper && passwordForIamSync && dbObject.email) {
          try {
            // Same reasoning as in update(): a `false` return means the reset landed in the
            // legacy store only, which is the shape of failure this whole path exists to
            // prevent. It must not be indistinguishable from success.
            const synced = await this.options.betterAuthUserMapper.syncPasswordChangeToIam(
              dbObject.email,
              passwordForIamSync,
            );
            if (!synced) {
              this.userServiceLogger.warn(
                `Password reset for ${maskEmail(dbObject.email)} was NOT synced to IAM (no credential account) — ` +
                  'the legacy password now differs from the IAM credential.',
              );
            }
          } catch (error) {
            // Log but don't fail - Legacy Auth password was updated successfully
            this.userServiceLogger.warn(
              `Failed to sync password reset to IAM for ${maskEmail(dbObject.email)}: ${error instanceof Error ? error.message : 'Unknown error'}`,
            );
          }
        }

        return updatedUser;
      },
      { dbObject, serviceOptions },
    );
  }

  /**
   * Set a password-reset token for an email address
   *
   * Returns `null` for an unknown address when `auth.passwordReset.preventUserEnumeration` is on
   * (the default since 11.38.0) — the caller must then answer exactly as it would for a known one.
   * With the option off it throws `NotFoundException`, the pre-11.38.0 behaviour.
   *
   * WHY THE DEFAULT CHANGED
   *
   * Throwing made the endpoint an account oracle: HTTP 404 for an unknown address, 201 for a known
   * one, so anyone could test who has an account. In a multi-tenant product that also answers who
   * works at which customer. The framework already answers this correctly on the IAM path —
   * Better-Auth's `/request-password-reset` returns the same body either way — so the two halves
   * of one framework disagreed about the same question.
   *
   * THE STATUS CODE IS THE SMALLER HALF
   *
   * Response TIME distinguishes the cases too, and by far more: the known path writes a token and
   * (in the caller) sends mail, the unknown path returns immediately. This method equalises what it
   * can — the token generation still happens, so the CPU cost matches — but the mail send lives in
   * the caller. A `sendPasswordResetMail()` that AWAITS the send leaks the difference as latency,
   * whatever this method does. `src/server/modules/user/user.service.ts` shows the shape that does
   * not; the IAM path uses the same trick, with the reasoning recorded in `better-auth.config.ts`.
   *
   * Anything measuring this honestly should say so rather than claim the channel is closed.
   */
  async setPasswordResetTokenForEmail(email: string, serviceOptions?: ServiceOptions): Promise<null | TUser> {
    return (await this.createPasswordResetToken(email, serviceOptions))?.user ?? null;
  }

  /**
   * Mint a password-reset token and hand back BOTH the token and the user.
   *
   * Use this instead of `setPasswordResetTokenForEmail` whenever the token itself is needed —
   * which is every caller that sends the mail, i.e. every project, because the mail templates are
   * project-specific.
   *
   * ── Why this method exists ──────────────────────────────────────────────────────
   * `setPasswordResetTokenForEmail` returns its result through `process()`, and the security
   * interceptor strips `passwordResetToken` on the way out. That is correct and must stay: a reset
   * token may never leave the server inside a response, and this service backs an endpoint.
   *
   * But the same return value is the only thing a caller had to build the mail link from. The
   * method named after setting the token did not hand it over, so `user.passwordResetToken` read
   * `undefined` and the mail went out with a link ending in `/undefined`.
   *
   * It fails in the worst shape available: the request succeeds, the mail arrives, it looks right,
   * and only the click reveals it — to somebody who by definition has no second way in. It reached
   * real recipients in a downstream project before anyone noticed, with a green test suite either
   * side of it, because the tests read the token from the DATABASE and never from the mail.
   *
   * The token is therefore generated OUTSIDE `process()` and returned alongside the scrubbed user.
   * Nothing about what leaves the server in a response changes.
   */
  async createPasswordResetToken(
    email: string,
    serviceOptions?: ServiceOptions,
  ): Promise<null | { token: string; user: TUser }> {
    // Same erased-type hazard as the token sinks (see `isQueryableString`): `{ $ne: null }` here
    // would select an arbitrary account and mint a live reset token for it. Treated as an unknown
    // address, which is the answer this method already gives for anything it cannot resolve — so
    // the enumeration parity below covers it too.
    if (!isQueryableString(email)) {
      return null;
    }

    // Get user
    const dbObject = await this.mainDbModel.findOne({ email }).exec();
    if (!dbObject) {
      const preventEnumeration =
        this.configService.getFastButReadOnly('auth')?.passwordReset?.preventUserEnumeration !== false;

      if (!preventEnumeration) {
        throw new NotFoundException(`No user found with email: ${email}`);
      }

      // Do the work the known path does, so the two do not differ in CPU cost. It is cheap next to
      // a mail send, which is why this alone does not close the timing channel — see the note above.
      crypto.randomBytes(32).toString('hex');

      this.userServiceLogger.debug(`Password reset requested for an unknown address (${maskEmail(email)})`);
      return null;
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = this.passwordResetTokenExpiry();

    const user = await this.process(
      async () => {
        // Set reset token and return
        dbObject.passwordResetToken = token;
        dbObject.passwordResetTokenExpiresAt = expiresAt;

        // Save
        await dbObject.save();

        // Return new user
        return dbObject;
      },
      { dbObject, serviceOptions },
    );

    return { token, user };
  }

  /**
   * How many minutes a password-reset token stays valid; `0` means it never expires.
   *
   * `0` opts OUT while any INVALID value falls back to the default, which is asymmetric on purpose:
   * switching off the expiry of a full-account-takeover credential is a decision somebody has to
   * state, and a typo in an environment variable must never be the thing that states it. So a
   * negative number, `NaN`, an empty string and a word all resolve to 60 rather than to "unbounded".
   *
   * The value is coerced from a string because configuration reaches this through `NEST_SERVER_CONFIG`
   * and `NSC__*`, where a number frequently arrives as one. `Number('')` is `0`, so an empty value
   * would otherwise read as a deliberate opt-out — it is rejected before the coercion.
   */
  protected passwordResetTokenExpiryMinutes(): number {
    const raw = this.configService.getFastButReadOnly<unknown>('auth.passwordReset.tokenExpiresInMinutes');

    if (typeof raw === 'string' && !raw.trim().length) {
      return DEFAULT_PASSWORD_RESET_TOKEN_EXPIRY_MINUTES;
    }

    const value = typeof raw === 'string' ? Number(raw) : raw;

    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return value;
    }

    return DEFAULT_PASSWORD_RESET_TOKEN_EXPIRY_MINUTES;
  }

  /**
   * The moment the token being minted stops being valid, or `null` when expiry is switched off.
   */
  protected passwordResetTokenExpiry(): Date | null {
    const minutes = this.passwordResetTokenExpiryMinutes();
    return minutes > 0 ? new Date(Date.now() + minutes * 60_000) : null;
  }

  /**
   * Whether a stored expiry timestamp has passed.
   *
   * A MISSING timestamp counts as expired. That is the load-bearing half: every token minted before
   * 11.38.0 has none, and reading "no timestamp" as "valid forever" would preserve exactly the
   * defect this closes — permanently, since those rows never gain one. The cost is that an
   * unredeemed reset mail from before the upgrade stops working, and the remedy is one click.
   *
   * With expiry switched off (`0`) nothing is expired, including those legacy rows: a project that
   * deliberately opted out must not have its tokens invalidated by the same setting.
   */
  protected isPasswordResetTokenExpired(expiresAt: Date | null | undefined): boolean {
    if (this.passwordResetTokenExpiryMinutes() === 0) {
      return false;
    }

    if (!expiresAt) {
      return true;
    }

    const time = expiresAt instanceof Date ? expiresAt.getTime() : new Date(expiresAt).getTime();

    // An unparseable timestamp is treated as expired rather than trusted — the safe direction for
    // a credential.
    return !Number.isFinite(time) || time <= Date.now();
  }

  /**
   * Build the link that goes into the password-reset mail.
   *
   * Mirrors `CoreBetterAuthEmailVerificationService.buildPasswordResetUrl` so the two reset flows
   * in this package resolve their link the same way. Resolution order, first hit wins:
   *
   *   1. `email.passwordResetLink` from the configuration
   *   2. `<appUrl>/auth/reset-password` — the starter's reset page
   *   3. `null`, when neither is available
   *
   * The app URL comes from `resolveServerUrls`, the same resolution the cookie and CORS setup
   * uses, rather than a raw read of `appUrl`. That is what gives `local`/`ci`/`e2e` their
   * documented localhost default and derives the app origin from a host-split `baseUrl` such as
   * `https://api.crm.localhost`. Reading the option directly — which is what the IAM twin still
   * does — makes a link that works in production come back empty in every local environment.
   *
   * `{token}` is substituted anywhere in the configured value. WITHOUT it the token is appended as
   * a PATH segment, which is what this flow has always done — changing that would silently break
   * every project already relying on it.
   *
   * Returns `null` rather than a string containing `undefined`. The option has no default and
   * nothing validated it, so a project that never set it produced `undefined/<token>` and sent it.
   * A caller that gets `null` here can log and send nothing, which is the honest failure: a mail
   * that does not arrive says "try again", one with a dead link says nothing at all.
   */
  buildPasswordResetLink(token: string): null | string {
    const configured = this.configService.getFastButReadOnly<string>('email.passwordResetLink');
    // One resolver for every mail link in this package — localhost defaults, host-split `baseUrl`,
    // and the `cors.deriveAppUrl` opt-out that keeps a reset token out of an untrusted apex domain.
    // Shared rather than inlined because the IAM twin drifted away from exactly this logic once.
    const appUrl = resolveAppUrlFromConfig(this.configService);

    let target = typeof configured === 'string' && configured.trim().length ? configured.trim() : undefined;

    if (!target) {
      if (!appUrl) {
        this.userServiceLogger.error(
          'Cannot build a password-reset link: neither `email.passwordResetLink` nor `appUrl` is configured',
        );
        return null;
      }
      target = `${appUrl.replace(/\/$/, '')}/auth/reset-password?token={token}`;
    }

    // A relative value resolves against appUrl, like the IAM flow does.
    if (target.startsWith('/')) {
      if (!appUrl) {
        this.userServiceLogger.error(
          'Cannot build a password-reset link: `email.passwordResetLink` is relative and `appUrl` is not configured',
        );
        return null;
      }
      target = `${appUrl.replace(/\/$/, '')}${target}`;
    }

    if (target.includes('{token}')) {
      return target.replace(/\{token\}/g, encodeURIComponent(token));
    }

    return `${target.replace(/\/$/, '')}/${encodeURIComponent(token)}`;
  }

  /**
   * Set roles for specified user
   */
  async setRoles(userId: string, roles: string[], serviceOptions?: ServiceOptions): Promise<TUser> {
    // Check roles
    if (!Array.isArray(roles)) {
      throw new BadRequestException('Missing roles');
    }

    // Check roles values
    if (roles.some((role) => typeof role !== 'string')) {
      throw new BadRequestException('Roles contains invalid values');
    }

    // Reject system roles (s_*). This is the framework's canonical "assign roles" API and it writes
    // straight through findByIdAndUpdate, so neither MapAndValidatePipe nor check() sees the values.
    // mongooseSystemRolePlugin is the backstop below this; the explicit check here exists to fail
    // before the DB round-trip and with a message naming the offending values.
    const systemRoles = roles.filter((role) => looksLikeSystemRole(role));
    if (systemRoles.length) {
      throw new BadRequestException(
        `System roles (${SYSTEM_ROLE_PREFIX}*) must never be stored in user.roles: ${systemRoles.join(', ')}`,
      );
    }

    // Update and return user
    return this.process(
      async () => {
        const user = await this.mainDbModel.findByIdAndUpdate(userId, { roles }).exec();

        // Invalidate BetterAuth user cache so changed roles take effect immediately
        if (this.options?.betterAuthUserMapper && (user as any)?.iamId) {
          this.options.betterAuthUserMapper.invalidateUserCache((user as any).iamId);
        }

        return user;
      },
      { serviceOptions },
    );
  }

  // ===================================================================================================================
  // Auth System Sync Methods
  // ===================================================================================================================

  /**
   * Update user with automatic email and password sync between Legacy and IAM auth systems
   *
   * When the email changes and BetterAuthUserMapper is available, this method:
   * - Invalidates all Better-Auth sessions (forces re-authentication)
   * - The shared users collection is automatically updated
   *
   * When the password changes:
   * - Updates the Legacy Auth password (bcrypt hash)
   * - Syncs to Better-Auth (IAM) if the user has a credential account
   */
  override async update(id: string, input: TUserInput, serviceOptions?: ServiceOptions): Promise<TUser> {
    // Get the current user before update to detect email changes
    const oldUser = (await this.mainDbModel.findById(id).lean().exec()) as null | TUser;
    const oldEmail = oldUser?.email;

    // Capture the submitted password for the IAM sync before super.update()
    // hashes it in place.
    //
    // Passed on exactly as received, including an already-sha256-hashed one —
    // see the note in `resetPassword`: the sync normalizes a 64-hex value
    // through unchanged, so skipping it there disabled the sync for the
    // standard setup, where the frontend hashes before sending.
    const passwordForIamSync = (input as any).password;

    // Perform the update
    const updatedUser = await super.update(id, input, serviceOptions);

    // Sync email change to IAM if email was changed and mapper is available
    if (this.options?.betterAuthUserMapper && oldEmail && input.email && oldEmail !== input.email) {
      try {
        await this.options.betterAuthUserMapper.syncEmailChangeFromLegacy(oldEmail, input.email);
        this.userServiceLogger.debug(`Synced email change from Legacy to IAM: ${oldEmail} → ${input.email}`);
      } catch (error) {
        this.userServiceLogger.error(
          `Failed to sync email change to IAM: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
        // Don't throw - email sync failure shouldn't block the update
      }
    }

    // Sync password change to IAM if password was changed and mapper is available
    if (this.options?.betterAuthUserMapper && passwordForIamSync && oldUser?.email) {
      try {
        // Report what actually happened, not that the call was made. `syncPasswordChangeToIam`
        // answers `false` — never throws — when there is no IAM credential to update, and
        // logging success regardless is how a half-applied password change stays invisible:
        // the endpoint reports success, the user is left with two different passwords, and
        // nothing in the log says so.
        const synced = await this.options.betterAuthUserMapper.syncPasswordChangeToIam(
          oldUser.email,
          passwordForIamSync,
        );
        if (synced) {
          this.userServiceLogger.debug(`Synced password change to IAM for user ${maskEmail(oldUser.email)}`);
        } else {
          this.userServiceLogger.warn(
            `Password change for ${maskEmail(oldUser.email)} was NOT synced to IAM (no credential account) — ` +
              'the legacy password now differs from the IAM credential.',
          );
        }
      } catch (error) {
        this.userServiceLogger.warn(
          `Failed to sync password change to IAM for ${maskEmail(oldUser.email)}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
        // Don't throw - password sync failure shouldn't block the update
      }
    }

    // Invalidate BetterAuth user cache when roles or verified status may have changed
    if (this.options?.betterAuthUserMapper && (oldUser as any)?.iamId) {
      const rolesChanged = 'roles' in (input as any);
      const verifiedChanged = 'verified' in (input as any) || 'emailVerified' in (input as any);
      if (rolesChanged || verifiedChanged) {
        this.options.betterAuthUserMapper.invalidateUserCache((oldUser as any).iamId);
      }
    }

    return updatedUser;
  }

  /**
   * Delete user with automatic cleanup of IAM auth data
   *
   * When BetterAuthUserMapper is available, this method also:
   * - Deletes all Better-Auth accounts for this user
   * - Deletes all Better-Auth sessions for this user
   *
   * This ensures no orphaned auth data remains after user deletion.
   */
  override async delete(id: string, serviceOptions?: ServiceOptions): Promise<TUser> {
    // Get the user before deletion to cleanup IAM data
    const user = (await this.mainDbModel.findById(id).lean().exec()) as null | (TUser & { _id: any });

    // Perform the deletion
    const deletedUser = await super.delete(id, serviceOptions);

    // Cleanup IAM data if mapper is available
    if (this.options?.betterAuthUserMapper && user?._id) {
      try {
        const result = await this.options.betterAuthUserMapper.cleanupIamDataForDeletedUser(user._id);
        if (result.accountsDeleted > 0 || result.sessionsDeleted > 0) {
          this.userServiceLogger.debug(
            `Cleaned up IAM data for deleted user ${id}: accounts=${result.accountsDeleted}, sessions=${result.sessionsDeleted}`,
          );
        }
      } catch (error) {
        this.userServiceLogger.error(
          `Failed to cleanup IAM data for deleted user: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
        // Don't throw - cleanup failure shouldn't block the delete response
      }
    }

    return deletedUser;
  }
}
