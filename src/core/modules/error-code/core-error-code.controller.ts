import { Controller, Get, NotFoundException, Param } from '@nestjs/common';

import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { CoreErrorCodeService } from './core-error-code.service';
import { IErrorTranslationResponse, SupportedLocale } from './interfaces/error-code.interfaces';

/**
 * Core Error Code Controller
 *
 * Provides REST endpoints for error translations.
 * This controller is publicly accessible (no authentication required).
 *
 * @example
 * GET /api/i18n/errors/de - Get German translations
 * GET /api/i18n/errors/en - Get English translations
 */
@Controller('api/i18n/errors')
export class CoreErrorCodeController {
  constructor(protected readonly errorCodeService: CoreErrorCodeService) {}

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
   *     "LTNS_0001": "Benutzer wurde nicht gefunden.",
   *     "LTNS_0002": "Das eingegebene Passwort ist ungültig.",
   *     "LTNS_0100": "Sie sind nicht angemeldet."
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
