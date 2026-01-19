import { Injectable } from '@nestjs/common';

import { CoreErrorCodeService } from '../../../core/modules/error-code/core-error-code.service';
import { ServerErrors } from './error-codes';

/**
 * Server Error Code Service
 *
 * Extends CoreErrorCodeService with project-specific error codes.
 * This service is automatically registered when using ErrorCodeModule.forRoot()
 * with the service option.
 *
 * @example
 * ```typescript
 * // In your module
 * ErrorCodeModule.forRoot({
 *   service: ErrorCodeService,
 * })
 * ```
 *
 * @example
 * ```typescript
 * // Extend with additional locales
 * @Injectable()
 * export class ErrorCodeService extends CoreErrorCodeService {
 *   protected override supportedLocales = ['de', 'en', 'fr', 'es'] as const;
 *
 *   constructor() {
 *     super();
 *     this.registerErrorRegistry(ProjectErrors);
 *   }
 * }
 * ```
 */
@Injectable()
export class ErrorCodeService extends CoreErrorCodeService {
  constructor() {
    super();
    // Register project-specific errors
    this.registerErrorRegistry(ServerErrors);
  }
}
