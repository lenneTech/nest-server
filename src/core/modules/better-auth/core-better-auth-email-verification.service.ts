import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import * as ejs from 'ejs';
import * as fs from 'fs';
import * as path from 'path';

import { maskEmail } from '../../common/helpers/logging.helper';
import { IBetterAuthEmailVerificationConfig } from '../../common/interfaces/server-options.interface';
import { BrevoService } from '../../common/services/brevo.service';
import { ConfigService } from '../../common/services/config.service';
import { EmailService } from '../../common/services/email.service';
import { TemplateService } from '../../common/services/template.service';
import { formatProjectName } from './better-auth.config';

/**
 * Resolved configuration type for email verification
 * Uses Required for mandatory fields but preserves optional nature of brevoTemplateId
 */
type ResolvedEmailVerificationConfig = Pick<IBetterAuthEmailVerificationConfig, 'brevoTemplateId' | 'callbackURL'>
  & Required<Omit<IBetterAuthEmailVerificationConfig, 'brevoTemplateId' | 'callbackURL' | 'resendCooldownSeconds'>>
  & { resendCooldownSeconds: number };

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
 * @Injectable()
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
@Injectable()
export class CoreBetterAuthEmailVerificationService {
  protected readonly logger = new Logger(CoreBetterAuthEmailVerificationService.name);
  protected config: ResolvedEmailVerificationConfig = DEFAULT_CONFIG;

  /**
   * In-memory tracking of last send time per email address for cooldown enforcement.
   * Key: email address (lowercase), Value: timestamp (ms) of last send
   */
  private readonly lastSendTimes = new Map<string, number>();

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
    @Optional() @Inject(CoreBetterAuthEmailVerificationService.BREVO_SERVICE_TOKEN) protected readonly brevoService?: BrevoService | null,
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

    // Check resend cooldown per email address
    if (this.isInCooldown(user.email)) {
      this.logger.debug(`Resend cooldown active for ${this.maskEmail(user.email)}, skipping email send`);
      return;
    }

    // Override URL if callbackURL is configured (frontend-based verification)
    if (this.config.callbackURL) {
      url = this.buildFrontendVerificationUrl(token);
    }

    // Always log verification URL for development/testing (useful for capturing in tests)
    // Uses console.log directly to ensure reliable capture in test environments (Vitest, Jest)
    // NestJS Logger may buffer output which makes interception unreliable in tests
    // eslint-disable-next-line no-console
    console.log(`[EMAIL VERIFICATION] User: ${user.email}, URL: ${url}`);

    // Brevo template path: send via Brevo transactional API if configured
    if (this.config.brevoTemplateId && this.brevoService) {
      try {
        const appName = this.getAppName();
        await this.brevoService.sendMail(user.email, this.config.brevoTemplateId, {
          appName,
          expiresIn: this.formatExpiresIn(this.config.expiresIn),
          link: url,
          name: user.name || user.email.split('@')[0],
        });
        this.trackSend(user.email);
        this.logger.debug(`Verification email sent via Brevo to ${this.maskEmail(user.email)}`);
        return;
      } catch (error) {
        this.logger.error(`Failed to send verification email via Brevo to ${this.maskEmail(user.email)}: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
        // Fallback template from nest-server: render directly via EJS
        const templateContent = fs.readFileSync(`${resolved.path}.ejs`, 'utf-8');
        const html = ejs.render(templateContent, templateData);

        await this.emailService.sendMail(
          user.email,
          this.getEmailSubject(appName),
          { html },
        );
      } else {
        // Project template: use TemplateService (relative path)
        await this.emailService.sendMail(
          user.email,
          this.getEmailSubject(appName),
          {
            htmlTemplate: resolved.path,
            templateData,
          },
        );
      }

      this.trackSend(user.email);
      this.logger.debug(`Verification email sent to ${this.maskEmail(user.email)}`);
    } catch (error) {
      this.logger.error(`Failed to send verification email to ${this.maskEmail(user.email)}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
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
    const rawConfig = this.configService.getFastButReadOnly<boolean | IBetterAuthEmailVerificationConfig>('betterAuth.emailVerification');

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
  protected async resolveTemplatePath(templateName: string, locale: string): Promise<{ isAbsolute: boolean; path: string }> {
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
        if (candidate.isNestServer) {
          // nest-server template: return absolute path (rendered directly via EJS)
          return { isAbsolute: true, path: fullPath.replace('.ejs', '') };
        }
        // Project template: return relative name (for TemplateService)
        return { isAbsolute: false, path: candidate.name };
      }
    }

    // Fallback to default template name (will likely fail, but provides clear error)
    this.logger.warn(`Template '${templateName}' not found in any location, using fallback`);
    return { isAbsolute: false, path: templateName };
  }

  /**
   * Get the app name for the email
   */
  protected getAppName(): string {
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
    if (!this.lastSendTimes.has(key) && this.lastSendTimes.size >= CoreBetterAuthEmailVerificationService.MAX_SEND_TIMES_ENTRIES) {
      // Map preserves insertion order - first key is the oldest
      const oldestKey = this.lastSendTimes.keys().next().value;
      if (oldestKey) {
        this.lastSendTimes.delete(oldestKey);
      }
    }

    this.lastSendTimes.set(key, Date.now());

    // Schedule cleanup to prevent memory leak
    const cooldown = this.config.resendCooldownSeconds;
    if (cooldown > 0) {
      setTimeout(() => this.lastSendTimes.delete(key), cooldown * 1000);
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
