import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { IBetterAuthSignUpChecksConfig } from '../../common/interfaces/server-options.interface';
import { ConfigService } from '../../common/services/config.service';
import { ErrorCode } from '../error-code/error-codes';

/**
 * Default configuration for sign-up checks
 */
const DEFAULT_CONFIG: Required<IBetterAuthSignUpChecksConfig> = {
  enabled: true,
  requiredFields: ['termsAndPrivacyAccepted'],
};

/**
 * Sign-up input interface for validation
 */
export interface SignUpValidationInput {
  /**
   * Allow additional fields for custom validation
   */
  [key: string]: unknown;

  /**
   * Whether terms and privacy policy were accepted
   */
  termsAndPrivacyAccepted?: boolean;
}

/**
 * CoreBetterAuthSignUpValidatorService validates sign-up input against configured required fields.
 *
 * This service enforces that certain fields must be provided and truthy during sign-up.
 * By default, `termsAndPrivacyAccepted` is required.
 *
 * **Enabled by Default:** Sign-up checks are enabled by default with
 * `requiredFields: ['termsAndPrivacyAccepted']`.
 *
 * @example
 * ```typescript
 * // In your resolver/controller
 * @Mutation(() => AuthModel)
 * async signUp(
 *   @Args('email') email: string,
 *   @Args('password') password: string,
 *   @Args('termsAndPrivacyAccepted') termsAndPrivacyAccepted: boolean,
 * ) {
 *   // Validate required fields
 *   this.signUpValidator.validateSignUpInput({ termsAndPrivacyAccepted });
 *
 *   // Continue with sign-up...
 * }
 * ```
 *
 * @example
 * ```typescript
 * // Disable sign-up checks in config.env.ts
 * betterAuth: {
 *   signUpChecks: false,
 * }
 * ```
 *
 * @example
 * ```typescript
 * // Custom required fields in config.env.ts
 * betterAuth: {
 *   signUpChecks: {
 *     requiredFields: ['termsAndPrivacyAccepted', 'ageConfirmed'],
 *   }
 * }
 * ```
 *
 * @since 11.13.0
 */
@Injectable()
export class CoreBetterAuthSignUpValidatorService {
  protected readonly logger = new Logger(CoreBetterAuthSignUpValidatorService.name);
  protected config: Required<IBetterAuthSignUpChecksConfig> = DEFAULT_CONFIG;

  constructor(protected readonly configService: ConfigService) {
    this.configure();
  }

  /**
   * Check if sign-up validation is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Get the current configuration
   */
  getConfig(): Required<IBetterAuthSignUpChecksConfig> {
    return { ...this.config };
  }

  /**
   * Get the list of required fields
   */
  getRequiredFields(): string[] {
    return [...this.config.requiredFields];
  }

  /**
   * Validate sign-up input against configured required fields
   *
   * @param input - The sign-up input to validate
   * @throws BadRequestException if any required field is missing or falsy
   */
  validateSignUpInput(input: SignUpValidationInput): void {
    if (!this.config.enabled) {
      return;
    }

    const missingFields: string[] = [];

    for (const field of this.config.requiredFields) {
      const value = input[field];

      // Check if the field is missing or falsy
      if (value === undefined || value === null || value === false || value === '') {
        missingFields.push(field);
      }
    }

    if (missingFields.length > 0) {
      this.logger.debug(`Sign-up validation failed: missing required fields: ${missingFields.join(', ')}`);

      // Throw specific error for termsAndPrivacyAccepted (most common case)
      if (missingFields.includes('termsAndPrivacyAccepted')) {
        throw new BadRequestException(ErrorCode.SIGNUP_TERMS_NOT_ACCEPTED);
      }

      // Generic error for other missing fields
      throw new BadRequestException(
        `${ErrorCode.SIGNUP_MISSING_REQUIRED_FIELDS} - Missing: ${missingFields.join(', ')}`,
      );
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
    const rawConfig = this.configService.getFastButReadOnly<boolean | IBetterAuthSignUpChecksConfig>('betterAuth.signUpChecks');

    // Sign-up checks are enabled by default
    if (rawConfig === undefined || rawConfig === null || rawConfig === true) {
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

    // Ensure requiredFields is an array
    if (!Array.isArray(this.config.requiredFields)) {
      this.config.requiredFields = DEFAULT_CONFIG.requiredFields;
    }
  }
}
