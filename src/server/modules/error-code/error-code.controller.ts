import { Controller, Get, NotFoundException, Param } from '@nestjs/common';

import { Roles } from '../../../core/common/decorators/roles.decorator';
import { RoleEnum } from '../../../core/common/enums/role.enum';
import {
  IErrorTranslationResponse,
  SupportedLocale,
} from '../../../core/modules/error-code/interfaces/error-code.interfaces';
import { ErrorCodeService } from './error-code.service';

/**
 * Server Error Code Controller
 *
 * Project-specific Error Code controller that provides error translation endpoints.
 * This is a standalone controller (not extending CoreErrorCodeController) to ensure
 * correct route registration order.
 *
 * Endpoints:
 * - GET /api/i18n/errors/codes - Get all available error codes (custom)
 * - GET /api/i18n/errors/:locale - Get translations for a locale
 *
 * **WHY standalone instead of extending CoreErrorCodeController?**
 * NestJS registers routes from parent classes first, regardless of method declaration
 * order in child classes. This causes parameterized routes (`:locale`) to intercept
 * static routes (`/codes`). A standalone controller ensures predictable route ordering.
 *
 * @example
 * ```typescript
 * // In your module
 * ErrorCodeModule.forRoot({
 *   controller: ErrorCodeController,
 *   service: ErrorCodeService,
 * })
 * ```
 */
@Controller('api/i18n/errors')
export class ErrorCodeController {
  constructor(protected readonly errorCodeService: ErrorCodeService) {}

  /**
   * Get all available error codes
   *
   * Returns a list of all registered error codes from all registries.
   * This endpoint must be defined BEFORE the :locale endpoint to prevent
   * "codes" being interpreted as a locale parameter.
   *
   * @returns Array of error codes
   *
   * @example
   * Response:
   * ```json
   * ["LTNS_0001", "LTNS_0002", "SRV_0001", "SRV_0002"]
   * ```
   */
  @Get('codes')
  @Roles(RoleEnum.S_EVERYONE)
  getAllCodes(): string[] {
    return this.errorCodeService.getErrorCodes();
  }

  /**
   * Get error translations for a specific locale
   *
   * Returns all error codes with their translations in Nuxt i18n compatible format.
   *
   * @param locale - Locale code (e.g., 'de', 'en')
   * @returns Translations object
   * @throws NotFoundException if locale is not supported
   *
   * @example
   * Response:
   * ```json
   * {
   *   "errors": {
   *     "LTNS_0001": "Benutzer mit E-Mail {email} wurde nicht gefunden.",
   *     "LTNS_0002": "Das eingegebene Passwort ist ungültig.",
   *     "SRV_0001": "Dies ist ein Demo-Fehler zu Testzwecken."
   *   }
   * }
   * ```
   */
  @Get(':locale')
  @Roles(RoleEnum.S_EVERYONE)
  getTranslations(@Param('locale') locale: string): IErrorTranslationResponse {
    if (!this.errorCodeService.isLocaleSupported(locale)) {
      throw new NotFoundException(
        `Locale "${locale}" is not supported. ` +
          `Supported locales: ${this.errorCodeService.getSupportedLocales().join(', ')}`,
      );
    }

    return this.errorCodeService.getTranslations(locale as SupportedLocale);
  }
}
