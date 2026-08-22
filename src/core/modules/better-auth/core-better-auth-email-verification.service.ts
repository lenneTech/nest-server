import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import ejs = require('ejs');
import * as fs from 'fs';
import * as path from 'path';

import { isProductionLikeEnv } from '../../common/helpers/cookies.helper';
import { maskEmail } from '../../common/helpers/logging.helper';
import { IBetterAuthEmailVerificationConfig } from '../../common/interfaces/server-options.interface';
import { BrevoService } from '../../common/services/brevo.service';
import { ConfigService } from '../../common/services/config.service';
import { CoreRedisService } from '../../common/services/core-redis.service';
import { EmailService } from '../../common/services/email.service';
import { TemplateService } from '../../common/services/template.service';
import { AuthEmailCallbackOptions, formatProjectName } from './better-auth.config';

/**
 * Resolved configuration type for email verification
 * Uses Required for mandatory fields but preserves optional nature of the
 * Brevo template ids — those stay undefined when no Brevo template is
 * configured, which is what selects the SMTP/EJS path.
 */
type ResolvedEmailVerificationConfig = Pick<
  IBetterAuthEmailVerificationConfig,
  'brevoTemplateId' | 'callbackURL' | 'passwordResetBrevoTemplateId'
> &
  Required<
    Omit<
      IBetterAuthEmailVerificationConfig,
      'brevoTemplateId' | 'callbackURL' | 'passwordResetBrevoTemplateId' | 'resendCooldownSeconds'
    >
  > & {
    resendCooldownSeconds: number;
  };

/**
 * Default configuration for email verification
 */
const DEFAULT_CONFIG: ResolvedEmailVerificationConfig = {
  autoSignInAfterVerification: true,
  callbackURL: '/auth/verify-email',
  enabled: true,
  expiresIn: 86400, // 24 hours in seconds
  locale: 'en',
  resendCooldownSeconds: 60,
  template: 'email-verification',
};

/**
 * Options for sending verification email
 */
export interface SendVerificationEmailOptions {
  /**
   * The token for email verification (used to build the verification URL)
   */
  token: string;

  /**
   * The verification URL to send to the user
   */
  url: string;

  /**
   * The user object from Better-Auth
   */
  user: {
    email: string;
    id: string;
    name?: null | string;
  };
}

/**
 * CoreBetterAuthEmailVerificationService handles email verification for Better-Auth.
 *
 * This service:
 * - Sends verification emails using nest-server's EmailService
 * - Resolves templates with project → nest-server fallback
 * - Syncs `verifiedAt` when email is verified
 *
 * **Template Resolution:**
 * Templates are resolved in this order:
 * 1. `<template>-<locale>.ejs` in project templates directory
 * 2. `<template>.ejs` in project templates directory
 * 3. `<template>-<locale>.ejs` in nest-server templates directory (fallback)
 * 4. `<template>.ejs` in nest-server templates directory (fallback)
 *
 * @example
 * ```typescript
 * // Override to customize email sending
 * export class MyEmailVerificationService extends CoreBetterAuthEmailVerificationService {
 *   override async sendVerificationEmail(options: SendVerificationEmailOptions): Promise<void> {
 *     // Custom logic before
 *     await super.sendVerificationEmail(options);
 *     // Custom logic after (e.g., analytics)
 *   }
 * }
 * ```
 *
 * @since 11.13.0
 */
/**
 * Sentinel returned when the slot was taken on the process-local path, where there is no Redis key
 * to compare against. Distinguishes "acquired locally" from "acquired in Redis with this token".
 */
const LOCAL_SLOT_TOKEN = 'local';

/**
 * Options for sending the password-reset email.
 *
 * Structurally the shared auth-email payload ({@link AuthEmailCallbackOptions}): `token` is the raw
 * reset token for consumers that build their own link, `url` the ready-made link Better-Auth
 * generated, `user` the account the reset was requested for. Aliased rather than redeclared so a
 * future field lands in one place instead of six.
 */
export type SendPasswordResetEmailOptions = AuthEmailCallbackOptions;

/**
 * Template for the password-reset mail. Resolved through the same
 * project-first / locale-aware lookup as the verification template, so a
 * deployment brands it by dropping its own `password-reset[-<locale>].ejs`
 * into the project template directory.
 */
const PASSWORD_RESET_TEMPLATE = 'password-reset';

@Injectable()
export class CoreBetterAuthEmailVerificationService {
  protected readonly logger = new Logger(CoreBetterAuthEmailVerificationService.name);

  /** Memoised `getAppName()` result — see the note there. */
  protected cachedAppName?: string;

  /** Compiled nest-server templates, keyed by resolved absolute path — see renderFrameworkTemplate. */
  protected readonly compiledTemplates = new Map<string, ejs.TemplateFunction>();

  /** Memoised `resolveTemplatePath()` results, keyed by `<name>:<locale>`. */
  protected readonly resolvedTemplatePaths = new Map<string, { isAbsolute: boolean; path: string }>();
  protected config: ResolvedEmailVerificationConfig = DEFAULT_CONFIG;

  /**
   * In-memory tracking of last send time per email address for cooldown enforcement.
   * Key: email address (lowercase), Value: timestamp (ms) of last send
   */
  protected readonly lastSendTimes = new Map<string, number>();

  /**
   * Pending cleanup timer per email, so a released slot can never expire a LATER cooldown
   */
  protected readonly sendTimers = new Map<string, NodeJS.Timeout>();

  /**
   * Token for optional BrevoService injection.
   * BrevoService cannot be injected directly with @Optional() because its
   * constructor throws when no brevo config exists. Instead, a factory
   * provider creates the instance or returns null.
   */
  static readonly BREVO_SERVICE_TOKEN = 'BETTER_AUTH_BREVO_SERVICE';

  constructor(
    protected readonly configService: ConfigService,
    @Optional() protected readonly emailService?: EmailService,
    @Optional() protected readonly templateService?: TemplateService,
    @Optional()
    @Inject(CoreBetterAuthEmailVerificationService.BREVO_SERVICE_TOKEN)
    protected readonly brevoService?: BrevoService | null,
    @Optional() protected readonly coreRedisService?: CoreRedisService,
  ) {
    this.configure();
  }

  /**
   * Check if email verification is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Get the email verification configuration
   */
  getConfig(): ResolvedEmailVerificationConfig {
    return { ...this.config };
  }

  /**
   * Get the expiration time in seconds
   */
  getExpiresIn(): number {
    return this.config.expiresIn;
  }

  /**
   * Check if auto sign-in after verification is enabled
   */
  shouldAutoSignIn(): boolean {
    return this.config.autoSignInAfterVerification;
  }

  /**
   * Send verification email to user
   *
   * This method is called by Better-Auth's emailVerification plugin hook.
   * Override this method to customize email sending behavior.
   *
   * @param options - The verification email options from Better-Auth
   */
  async sendVerificationEmail(options: SendVerificationEmailOptions): Promise<void> {
    const { token, user } = options;
    let { url } = options;

    // Reserve the cooldown slot per email address (atomic across replicas with Redis).
    // `slotToken`, not `token` — `token` is already the verification token from the options.
    const slotToken = await this.acquireSendSlot(user.email);
    if (!slotToken) {
      this.logger.debug(`Resend cooldown active for ${this.maskEmail(user.email)}, skipping email send`);
      return;
    }

    // Only a SUCCESSFUL send may burn the cooldown — the slot is released again below otherwise
    let sent = false;

    try {
      // Override URL if callbackURL is configured (frontend-based verification)
      if (this.config.callbackURL) {
        url = this.buildFrontendVerificationUrl(token);
      }

      this.logAuthUrlForDevelopment('EMAIL VERIFICATION', user.email, url);

      // Brevo template path: send via Brevo transactional API if configured
      if (this.config.brevoTemplateId && this.brevoService) {
        try {
          const appName = this.getAppName();
          const result = await this.brevoService.sendMail(user.email, this.config.brevoTemplateId, {
            appName,
            expiresIn: this.formatExpiresIn(this.config.expiresIn),
            link: url,
            name: user.name || user.email.split('@')[0],
          });

          // `sendMail()` swallows SDK errors and resolves to `null` (unless `brevo.throwOnError` is
          // set), so "did not throw" is NOT "was delivered". Recording a send here on a null would
          // mark the address as mailed, log success, and skip the SMTP fallback below — leaving the
          // user with no verification email at all on a Brevo outage or a revoked key.
          if (result === null) {
            this.logger.error(
              `Brevo verification send failed for ${this.maskEmail(user.email)} — falling back to SMTP`,
            );
            // Deliberately no `return`: fall through to the EmailService path.
          } else {
            sent = true;
            this.logger.debug(`Verification email sent via Brevo to ${this.maskEmail(user.email)}`);
            return;
          }
        } catch (error) {
          this.logger.error(
            `Failed to send verification email via Brevo to ${this.maskEmail(user.email)}: ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
          throw error;
        }
      }

      if (!this.emailService) {
        this.logger.warn('EmailService not available, cannot send verification email');
        return;
      }

      try {
        const resolved = await this.resolveTemplatePath(this.config.template, this.config.locale);
        const appName = this.getAppName();

        const templateData = {
          appName,
          expiresIn: this.formatExpiresIn(this.config.expiresIn),
          link: url,
          name: user.name || user.email.split('@')[0],
        };

        if (resolved.isAbsolute) {
          // Fallback template from nest-server: render directly via EJS (compiled once)
          const html = this.renderFrameworkTemplate(resolved.path, templateData);

          await this.emailService.sendMail(user.email, this.getEmailSubject(appName), { html });
        } else {
          // Project template: use TemplateService (relative path)
          await this.emailService.sendMail(user.email, this.getEmailSubject(appName), {
            htmlTemplate: resolved.path,
            templateData,
          });
        }

        sent = true;
        this.logger.debug(`Verification email sent to ${this.maskEmail(user.email)}`);
      } catch (error) {
        this.logger.error(
          `Failed to send verification email to ${this.maskEmail(user.email)}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
        throw error;
      }
    } finally {
      if (!sent) {
        await this.releaseSendSlot(user.email, slotToken);
      }
    }
  }

  /**
   * Send the password-reset email.
   *
   * Called from Better-Auth's `emailAndPassword.sendResetPassword` hook.
   * Override to customise delivery.
   *
   * Deliberately does NOT consult `isEnabled()` / `emailVerification.enabled`. Those govern email
   * VERIFICATION; switching that off must not also take away password recovery, which is a
   * different concern and the only way back in for a locked-out user. The reset flow's own switch
   * is `betterAuth.emailAndPassword.passwordReset`. (This method lives on the verification service
   * because it shares the template lookup, the Brevo overlay and the cooldown store with it — the
   * config key `passwordResetBrevoTemplateId` sits under `emailVerification` for the same reason.)
   *
   * Throttled per ADDRESS (see the slot comment in the body), not per session: the abuse this
   * unauthenticated route enables runs on the recipient axis, which an IP-keyed limiter cannot
   * express. The route-level `betterAuth.rateLimit` remains the IP-axis bound.
   *
   * @param options - The reset email options from Better-Auth
   * @throws Re-throws a Brevo or SMTP send failure after logging it with the masked address. The
   *   framework's own caller (`sendResetPassword` in better-auth.config.ts) invokes this through
   *   `sendAuthEmailSafely`, which catches and logs — so a throw never reaches the request. An
   *   override that calls this directly must handle it.
   */
  async sendPasswordResetEmail(options: SendPasswordResetEmailOptions): Promise<void> {
    const { url, user } = options;

    this.logAuthUrlForDevelopment('PASSWORD RESET', user.email, url);

    // Per-ADDRESS throttle. The abuse this route enables runs on the RECIPIENT axis: an attacker
    // rotating IPs mail-bombs one victim and writes one `verification` document per request, and an
    // IP-keyed limiter cannot express "one reset mail per address per window". The slot is
    // namespaced so the two flows cannot starve each other — a pending verification mail must not
    // block a password reset.
    //
    // Returning early is enumeration-safe: Better-Auth has already produced its uniform
    // "if this email exists in our system…" response by the time this hook runs, and the send is
    // detached, so nothing about the response varies.
    const slotKey = `${PASSWORD_RESET_TEMPLATE}:${user.email}`;
    const slotToken = await this.acquireSendSlot(slotKey);
    if (!slotToken) {
      this.logger.debug(`Password-reset cooldown active for ${this.maskEmail(user.email)}, skipping email send`);
      return;
    }

    // Only a SUCCESSFUL send may burn the cooldown — otherwise a transient SMTP failure would lock
    // a user out of retrying for the whole window, on the one route that gets them back in.
    let sent = false;

    try {
      const appName = this.getAppName();
      const templateData = {
        appName,
        link: url,
        name: user.name || user.email.split('@')[0],
      };

      // Brevo path: only when a reset-specific template is configured. Falling back
      // to the VERIFICATION template id here would mail the user "confirm your
      // address" for a password reset.
      if (this.config.passwordResetBrevoTemplateId && this.brevoService) {
        try {
          const result = await this.brevoService.sendMail(
            user.email,
            this.config.passwordResetBrevoTemplateId,
            templateData,
          );

          // `sendMail()` swallows SDK errors and resolves to `null` unless
          // `brevo.throwOnError` is set, so "did not throw" is NOT "was delivered".
          // Returning here on a null would leave a locked-out user with no mail at
          // all; fall through to SMTP instead. Mirrors sendVerificationEmail.
          if (result === null) {
            this.logger.error(
              `Brevo password-reset send failed for ${this.maskEmail(user.email)} — falling back to SMTP`,
            );
            // Deliberately no `return`: fall through to the EmailService path.
          } else {
            sent = true;
            this.logger.debug(`Password-reset email sent via Brevo to ${this.maskEmail(user.email)}`);
            return;
          }
        } catch (error) {
          // Mirrors sendVerificationEmail: a Brevo THROW skips the SMTP fallback (only a `null`
          // falls through). The address-identifying line matters — without it the only trace is
          // the generic handler in better-auth.config.ts, which knows neither the user nor which
          // of the two mail paths failed.
          this.logger.error(
            `Failed to send password-reset email via Brevo to ${this.maskEmail(user.email)}: ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
          throw error;
        }
      }

      if (!this.emailService) {
        this.logger.warn('EmailService not available, cannot send password-reset email');
        return;
      }

      try {
        const resolved = await this.resolveTemplatePath(PASSWORD_RESET_TEMPLATE, this.config.locale);
        const subject = this.getPasswordResetSubject(appName);

        if (resolved.isAbsolute) {
          // nest-server fallback template: render directly via EJS (compiled once, see the helper)
          const html = this.renderFrameworkTemplate(resolved.path, templateData);
          await this.emailService.sendMail(user.email, subject, { html });
        } else {
          // Project template: use TemplateService (relative path)
          await this.emailService.sendMail(user.email, subject, {
            htmlTemplate: resolved.path,
            templateData,
          });
        }

        sent = true;
        this.logger.debug(`Password-reset email sent to ${this.maskEmail(user.email)}`);
      } catch (error) {
        this.logger.error(
          `Failed to send password-reset email to ${this.maskEmail(user.email)}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
        throw error;
      }
    } finally {
      if (!sent) {
        await this.releaseSendSlot(slotKey, slotToken);
      }
    }
  }

  /**
   * Reserve the resend-cooldown slot for an email address.
   *
   * With Redis configured this is a single atomic `SET NX PX`, so two replicas
   * handling concurrent resend requests cannot both pass the cooldown. Without
   * Redis it falls back to the process-local {@link isInCooldown}/{@link trackSend}.
   *
   * @returns a truthy slot token when the caller may send, `null` while the cooldown is active.
   *   The token is what {@link releaseSendSlot} compares against before deleting the key, so a
   *   release can only ever clear the slot IT acquired. A subclass overriding this and returning a
   *   plain `true` still works — release then falls back to the previous unconditional delete.
   */
  protected async acquireSendSlot(email: string): Promise<null | string> {
    const cooldown = this.config.resendCooldownSeconds;
    if (cooldown <= 0) {
      return LOCAL_SLOT_TOKEN;
    }

    if (this.coreRedisService?.enabled) {
      try {
        const token = randomUUID();
        const result = await this.coreRedisService
          .getClient()
          .set(this.cooldownKey(email), token, 'PX', cooldown * 1000, 'NX');
        return result === 'OK' ? token : null;
      } catch (error) {
        // Degrade to the process-local cooldown rather than failing closed. An unhandled error
        // here reads as "cooldown active" and would stop verification mail entirely for the
        // duration of a Redis blip — locking new users out of their accounts. The local counter
        // is the pre-Redis behavior: still a real anti-flood bound, just per replica.
        this.logger.warn(
          `Redis cooldown unavailable, falling back to the per-replica counter: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`,
        );
      }
    }

    if (this.isInCooldown(email)) {
      return null;
    }
    this.trackSend(email);
    return LOCAL_SLOT_TOKEN;
  }

  /**
   * Release a slot reserved by {@link acquireSendSlot} — used when no email was
   * actually sent, so a failed send does not burn the cooldown.
   */
  protected async releaseSendSlot(email: string, token?: null | string): Promise<void> {
    if (this.config.resendCooldownSeconds <= 0) {
      return;
    }

    if (this.coreRedisService?.enabled) {
      // Releasing runs in a `finally` after a FAILED send. Letting a Redis error escape here
      // would replace the real send failure with a connection error in the caller's log — and
      // the key expires on its own TTL anyway, so the worst case is one cooldown served out.
      // Compare-and-delete, never a bare DEL. Releasing runs in a `finally` after a FAILED send,
      // and a send can fail SLOWER than the cooldown (an SMTP socket timeout outlives a 60s
      // window comfortably). By then our key has expired and a later request holds a new one — an
      // unconditional delete would clear THAT request's cooldown, and repeating the trick floods
      // a chosen address with valid verification links. Same pattern as the migration lock and
      // the TUS locker.
      if (typeof token === 'string' && token !== LOCAL_SLOT_TOKEN) {
        const script = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
        await this.coreRedisService
          .getClient()
          .eval(script, 1, this.cooldownKey(email), token)
          .catch(() => undefined);
      } else if (token === undefined) {
        // No token supplied (a subclass acquired the slot the old way) — preserve the previous
        // behavior rather than silently skipping the release.
        await this.coreRedisService
          .getClient()
          .del(this.cooldownKey(email))
          .catch(() => undefined);
      }
      // Deliberately NOT `return`: when acquire fell back to the local counter because Redis
      // errored, the Redis key was never written and only the local entry exists. Branching on
      // `enabled` alone would leave it in place, so the failed send would burn the cooldown —
      // the exact semantics the acquire/release split exists to preserve. Clearing both is
      // harmless: the local map is empty whenever Redis actually served the acquire.
    }

    // Clear the pending cleanup timer too. Left running, it would fire `cooldown` seconds
    // after the FAILED send and delete whatever entry exists then — which is the entry of a
    // later, successful send. The cooldown would end early and the anti-flood control it
    // exists to be would quietly weaken.
    const key = email.toLowerCase();
    clearTimeout(this.sendTimers.get(key));
    this.sendTimers.delete(key);
    this.lastSendTimes.delete(key);
  }

  /**
   * Redis key for the resend cooldown of an email address
   */
  protected cooldownKey(email: string): string {
    return this.coreRedisService!.key('email-verification-cooldown', email.toLowerCase());
  }

  /**
   * Configure the service with Better-Auth settings
   *
   * Follows the "presence implies enabled" pattern:
   * - If config is undefined/null: enabled with defaults
   * - If config is `true`: enabled with defaults
   * - If config is `false`: disabled
   * - If config is an object: enabled with merged settings (unless `enabled: false`)
   */
  protected configure(): void {
    const rawConfig = this.configService.getFastButReadOnly<boolean | IBetterAuthEmailVerificationConfig>(
      'betterAuth.emailVerification',
    );

    // false = explicitly disabled
    if (rawConfig === false) {
      this.config = { ...DEFAULT_CONFIG, enabled: false };
      return;
    }

    // undefined/null/true = enabled with defaults (zero-config: email verification is on by default)
    if (!rawConfig || rawConfig === true) {
      this.config = { ...DEFAULT_CONFIG, enabled: true };
      return;
    }

    // Object config: merge with defaults, enabled unless explicitly disabled
    this.config = {
      ...DEFAULT_CONFIG,
      ...rawConfig,
      enabled: rawConfig.enabled !== false,
    };
  }

  /**
   * Build the frontend verification URL from the configured callbackURL and token.
   *
   * Resolves relative paths against `appUrl`. Appends the token as a query parameter.
   *
   * @param token - The verification token from Better-Auth
   * @returns The full frontend URL with token query parameter
   */
  protected buildFrontendVerificationUrl(token: string): string {
    let baseUrl = this.config.callbackURL!;

    // Resolve relative paths against appUrl
    if (baseUrl.startsWith('/')) {
      const appUrl = this.configService.getFastButReadOnly<string>('appUrl') || 'http://localhost:3001';
      baseUrl = `${appUrl.replace(/\/$/, '')}${baseUrl}`;
    }

    // Append token as query parameter
    const separator = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${separator}token=${token}`;
  }

  /**
   * Resolve template path with fallback logic
   *
   * Resolution order:
   * 1. `<template>-<locale>.ejs` in project templates
   * 2. `<template>.ejs` in project templates
   * 3. `<template>-<locale>.ejs` in nest-server templates
   * 4. `<template>.ejs` in nest-server templates
   *
   * @param templateName - The template name without extension
   * @param locale - The locale for the template
   * @returns Object with `path` (without .ejs) and `isAbsolute` flag
   */
  protected async resolveTemplatePath(
    templateName: string,
    locale: string,
  ): Promise<{ isAbsolute: boolean; path: string }> {
    // Memoised: this walk costs up to four blocking `existsSync` calls, and it runs per outgoing
    // auth mail on a route an unauthenticated caller can drive. Template files do not appear at
    // runtime, so re-walking buys nothing after the first resolution.
    const cacheKey = `${templateName}:${locale}`;
    const cached = this.resolvedTemplatePaths.get(cacheKey);
    if (cached) {
      return cached;
    }

    const projectTemplatesPath = this.configService.getFastButReadOnly<string>('templates.path');
    const nestServerTemplatesPath = path.join(__dirname, '..', '..', '..', 'templates');

    const candidates = [
      // Project templates (with locale)
      { base: projectTemplatesPath, isNestServer: false, name: `${templateName}-${locale}` },
      // Project templates (without locale)
      { base: projectTemplatesPath, isNestServer: false, name: templateName },
      // nest-server templates (with locale)
      { base: nestServerTemplatesPath, isNestServer: true, name: `${templateName}-${locale}` },
      // nest-server templates (without locale)
      { base: nestServerTemplatesPath, isNestServer: true, name: templateName },
    ];

    for (const candidate of candidates) {
      if (!candidate.base) continue;

      const fullPath = path.join(candidate.base, `${candidate.name}.ejs`);
      if (fs.existsSync(fullPath)) {
        const resolved = candidate.isNestServer
          ? // nest-server template: absolute path (rendered directly via EJS)
            { isAbsolute: true, path: fullPath.replace('.ejs', '') }
          : // Project template: relative name (for TemplateService)
            { isAbsolute: false, path: candidate.name };
        this.resolvedTemplatePaths.set(cacheKey, resolved);
        return resolved;
      }
    }

    // Fallback to default template name (will likely fail, but provides clear error)
    this.logger.warn(`Template '${templateName}' not found in any location, using fallback`);
    return { isAbsolute: false, path: templateName };
  }

  /**
   * Get the app name for the email
   */
  /**
   * Render a nest-server fallback template, compiling it at most once per resolved path.
   *
   * `TemplateService` already caches compiled templates — but only for PROJECT templates. The
   * absolute-path branch bypasses it entirely, so before this every outgoing auth mail re-read the
   * file and re-compiled the EJS: measured at ~113 µs of event-loop-blocking work per mail against
   * ~2 µs for a cached call. `readFileSync` blocks every other in-flight request while it runs, and
   * the password-reset route that drives it is unauthenticated.
   *
   * Template files do not appear or change at runtime, so an unbounded map is bounded in practice
   * by the number of templates on disk.
   */
  protected renderFrameworkTemplate(pathWithoutExtension: string, data: Record<string, unknown>): string {
    let compiled = this.compiledTemplates.get(pathWithoutExtension);
    if (!compiled) {
      compiled = ejs.compile(fs.readFileSync(`${pathWithoutExtension}.ejs`, 'utf-8'));
      this.compiledTemplates.set(pathWithoutExtension, compiled);
    }
    return compiled(data);
  }

  /**
   * Print an auth link (verification / password reset) to stdout for local development.
   *
   * The URL embeds a bearer token: the verification link confirms an address, the reset link
   * changes a password outright. Neither may reach a deployment holding real accounts, so the gate
   * is `isProductionLikeEnv()` — the same two-layer check `EmailService` and the cookie helpers
   * already use. `NODE_ENV !== 'production'` alone is NOT enough: a staging deployment sets
   * `NODE_ENV=staging` so `getEnvironmentConfig()` loads its config block, which passes that test
   * while holding real users.
   *
   * The address is masked (PII, and the rest of this file already masks it); the URL is printed in
   * full because following it without a mail server is the whole point locally. Set
   * `LT_LOG_AUTH_URLS=0` to suppress it even outside production.
   *
   * `console.log` rather than the NestJS logger, deliberately and for two reasons: the logger
   * buffers, which makes interception unreliable under Vitest, and a logger call would route the
   * token into `HubLogBufferService`'s ring buffer, which is readable over HTTP by any ADMIN.
   */
  protected logAuthUrlForDevelopment(label: string, email: string, url: string): void {
    if (process.env.LT_LOG_AUTH_URLS === '0') {
      return;
    }
    if (isProductionLikeEnv(this.configService?.getFastButReadOnly<string>('env'))) {
      return;
    }
    // oxlint-disable-next-line no-console
    console.log(`[${label}] User: ${this.maskEmail(email)}, URL: ${url}`);
  }

  protected getAppName(): string {
    // `package.json` never changes at runtime, but this runs once per outgoing auth mail — on a
    // route an unauthenticated caller can drive. Cache it so that cannot become a synchronous
    // file read per request. Mirrors `cachedProjectAppName` in better-auth.config.ts.
    if (this.cachedAppName !== undefined) {
      return this.cachedAppName;
    }
    this.cachedAppName = this.resolveAppName();
    return this.cachedAppName;
  }

  /**
   * Resolve the application name from package.json, falling back to a framework default.
   */
  protected resolveAppName(): string {
    // Try to get from package.json name
    try {
      const packageJsonPath = path.join(process.cwd(), 'package.json');
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      if (packageJson.name) {
        return this.formatProjectName(packageJson.name);
      }
    } catch {
      // Ignore
    }
    return 'Nest Server';
  }

  /**
   * Format project name from package.json
   * @deprecated Use the shared formatProjectName from better-auth.config.ts directly instead
   */
  protected formatProjectName(name: string): string {
    return formatProjectName(name);
  }

  /**
   * Get the email subject
   */
  protected getEmailSubject(appName: string): string {
    const locale = this.config.locale;
    if (locale === 'de') {
      return `${appName} - E-Mail-Adresse bestätigen`;
    }
    return `${appName} - Verify your email address`;
  }

  /**
   * Subject line of the password-reset mail.
   */
  protected getPasswordResetSubject(appName: string): string {
    const subjects: Record<string, string> = {
      de: `${appName} - Passwort zurücksetzen`,
      en: `${appName} - Reset your password`,
    };
    return subjects[this.config.locale] ?? subjects.en;
  }

  /**
   * Format expires in seconds to human readable string
   */
  protected formatExpiresIn(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const locale = this.config.locale;

    if (hours >= 24) {
      const days = Math.floor(hours / 24);
      if (locale === 'de') {
        return days === 1 ? '1 Tag' : `${days} Tage`;
      }
      return days === 1 ? '1 day' : `${days} days`;
    }

    if (locale === 'de') {
      return hours === 1 ? '1 Stunde' : `${hours} Stunden`;
    }
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }

  /**
   * Check if an email address is still in the resend cooldown period
   */
  protected isInCooldown(email: string): boolean {
    const cooldown = this.config.resendCooldownSeconds;
    if (cooldown <= 0) return false;

    const key = email.toLowerCase();
    const lastSend = this.lastSendTimes.get(key);
    if (!lastSend) return false;

    const elapsed = (Date.now() - lastSend) / 1000;
    return elapsed < cooldown;
  }

  /**
   * Maximum entries in the lastSendTimes map to prevent unbounded growth.
   * At 10,000 entries with email strings as keys, this uses ~1-2 MB max.
   */
  private static readonly MAX_SEND_TIMES_ENTRIES = 10000;

  /**
   * Track that a verification email was sent to this address
   */
  protected trackSend(email: string): void {
    const key = email.toLowerCase();

    // Evict oldest entry if map is at capacity (before adding new one)
    if (
      !this.lastSendTimes.has(key) &&
      this.lastSendTimes.size >= CoreBetterAuthEmailVerificationService.MAX_SEND_TIMES_ENTRIES
    ) {
      // Map preserves insertion order - first key is the oldest
      const oldestKey = this.lastSendTimes.keys().next().value;
      if (oldestKey) {
        this.lastSendTimes.delete(oldestKey);
      }
    }

    this.lastSendTimes.set(key, Date.now());

    // Schedule cleanup to prevent memory leak. Any timer left over from an earlier,
    // RELEASED send is cancelled first — it would otherwise delete THIS entry when it
    // fires and end the new cooldown early.
    const cooldown = this.config.resendCooldownSeconds;
    if (cooldown > 0) {
      clearTimeout(this.sendTimers.get(key));
      const timer = setTimeout(() => {
        this.lastSendTimes.delete(key);
        this.sendTimers.delete(key);
      }, cooldown * 1000);
      timer.unref?.();
      this.sendTimers.set(key, timer);
    }
  }

  /**
   * Mask email for logging (privacy)
   * @deprecated Use the shared maskEmail from logging.helper.ts directly instead
   */
  protected maskEmail(email: string): string {
    return maskEmail(email);
  }
}
