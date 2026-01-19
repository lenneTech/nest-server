import { Type } from '@nestjs/common';

import { CoreErrorCodeService } from '../core-error-code.service';
import { IErrorRegistry } from '../error-codes';

/**
 * Configuration for the error code module
 */
export interface IErrorCodeModuleConfig {
  /**
   * Additional error registry to merge with core errors
   *
   * @example
   * ```typescript
   * const ProjectErrors = {
   *   ORDER_NOT_FOUND: {
   *     code: 'PROJ_0001',
   *     message: 'Order not found',
   *     translations: { de: 'Bestellung nicht gefunden.', en: 'Order not found.' }
   *   }
   * } as const satisfies IErrorRegistry;
   *
   * ErrorCodeModule.forRoot({ additionalErrorRegistry: ProjectErrors })
   * ```
   */
  additionalErrorRegistry?: IErrorRegistry;

  /**
   * Custom controller class to use instead of CoreErrorCodeController.
   *
   * **Note:** Use a standalone controller (not extending CoreErrorCodeController)
   * to ensure correct route registration order when adding new routes.
   * NestJS registers parent routes first, which can cause parameterized routes
   * to intercept static routes.
   *
   * @example
   * ```typescript
   * // Standalone controller (RECOMMENDED)
   * @Controller('api/i18n/errors')
   * export class ErrorCodeController {
   *   constructor(protected readonly errorCodeService: ErrorCodeService) {}
   *
   *   @Get('codes')  // Must be defined BEFORE :locale
   *   @Roles(RoleEnum.S_EVERYONE)
   *   getAllCodes(): string[] {
   *     return this.errorCodeService.getErrorCodes();
   *   }
   *
   *   @Get(':locale')
   *   @Roles(RoleEnum.S_EVERYONE)
   *   getTranslations(@Param('locale') locale: string) { ... }
   * }
   *
   * // In your module
   * ErrorCodeModule.forRoot({
   *   controller: ErrorCodeController,
   *   service: ErrorCodeService,
   * })
   * ```
   */
  controller?: Type<any>;

  /**
   * Custom service class to use instead of CoreErrorCodeService.
   * The class must extend CoreErrorCodeService.
   *
   * @example
   * ```typescript
   * // Your custom service with additional locales
   * @Injectable()
   * export class ErrorCodeService extends CoreErrorCodeService {
   *   protected override supportedLocales: SupportedLocale[] = ['de', 'en', 'fr', 'es'];
   *
   *   constructor() {
   *     super();
   *     this.registerErrorRegistry(ProjectErrors);
   *   }
   * }
   *
   * // In your module
   * ErrorCodeModule.forRoot({
   *   service: ErrorCodeService,
   * })
   * ```
   */
  service?: Type<CoreErrorCodeService>;
}

/**
 * Response format for the translation endpoint
 */
export interface IErrorTranslationResponse {
  errors: Record<string, string>;
}

/**
 * Supported locales for error translations
 */
export type SupportedLocale = 'de' | 'en';
