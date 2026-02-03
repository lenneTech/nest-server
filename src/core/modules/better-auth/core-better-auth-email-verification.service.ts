import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import * as ejs from 'ejs';
import * as fs from 'fs';
import * as path from 'path';

import { IBetterAuthEmailVerificationConfig } from '../../common/interfaces/server-options.interface';
import { BrevoService } from '../../common/services/brevo.service';
import { ConfigService } from '../../common/services/config.service';
import { EmailService } from '../../common/services/email.service';
import { TemplateService } from '../../common/services/template.service';

/**
 * Resolved configuration type for email verification
 * Uses Required for mandatory fields but preserves optional nature of brevoTemplateId
 */
type ResolvedEmailVerificationConfig = Pick<IBetterAuthEmailVerificationConfig, 'brevoTemplateId'>
  & Required<Omit<IBetterAuthEmailVerificationConfig, 'brevoTemplateId'>>;

/**
 * Default configuration for email verification
 */
const DEFAULT_CONFIG: ResolvedEmailVerificationConfig = {
  autoSignInAfterVerification: true,
  enabled: true,
  expiresIn: 86400, // 24 hours in seconds
  locale: 'en',
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
 * @since 11.12.1
 */
@Injectable()
export class CoreBetterAuthEmailVerificationService {
  protected readonly logger = new Logger(CoreBetterAuthEmailVerificationService.name);
  protected config: ResolvedEmailVerificationConfig = DEFAULT_CONFIG;

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
    const { url, user } = options;

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

    // Follow "presence implies enabled" pattern:
    // No config = disabled (backward compatible)
    if (rawConfig === undefined || rawConfig === null) {
      this.config = { ...DEFAULT_CONFIG, enabled: false };
      return;
    }

    // Boolean shorthand: true = enabled with defaults, false = disabled
    if (rawConfig === true) {
      this.config = { ...DEFAULT_CONFIG, enabled: true };
      return;
    }

    if (rawConfig === false) {
      this.config = { ...DEFAULT_CONFIG, enabled: false };
      return;
    }

    // Object config: merge with defaults
    const enabled = rawConfig.enabled !== false;
    this.config = {
      ...DEFAULT_CONFIG,
      ...rawConfig,
      enabled,
    };
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
   */
  protected formatProjectName(name: string): string {
    // Remove scope (e.g., '@org/my-app' → 'my-app')
    let formatted = name.replace(/^@[^/]+\//, '');
    // Convert kebab-case to Title Case
    formatted = formatted
      .split(/[-_]/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
    return formatted;
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
   * Mask email for logging (privacy)
   */
  protected maskEmail(email: string): string {
    const [local, domain] = email.split('@');
    if (!domain) return '***';
    const maskedLocal = local.length > 2
      ? `${local[0]}***${local[local.length - 1]}`
      : '***';
    return `${maskedLocal}@${domain}`;
  }
}
