import { IErrorRegistry, mergeErrorCodes } from '../../../core/modules/error-code/error-codes';

/**
 * Server-specific Error Registry
 *
 * Project-specific error codes that extend the core LTNS_* errors.
 * Use a unique prefix (e.g., SRV_ for Server) to avoid conflicts.
 *
 * Error code ranges for this project:
 * - SRV_0001-SRV_0099: Business logic errors
 * - SRV_0100-SRV_0199: Integration errors
 *
 * @example
 * ```typescript
 * import { UnprocessableEntityException } from '@nestjs/common';
 * import { ErrorCode } from './error-codes';
 *
 * throw new UnprocessableEntityException(ErrorCode.DEMO_ERROR);
 * // Response: { statusCode: 422, message: "#SRV_0001: Demo error for testing" }
 * ```
 */
export const ServerErrors = {
  // =====================================================
  // Business Logic Errors (SRV_0001-SRV_0099)
  // =====================================================

  DEMO_ERROR: {
    code: 'SRV_0001',
    message: 'Demo error for testing',
    translations: {
      de: 'Dies ist ein Demo-Fehler zu Testzwecken.',
      en: 'This is a demo error for testing purposes.',
    },
  },

  FEATURE_NOT_AVAILABLE: {
    code: 'SRV_0002',
    message: 'Feature not available in this environment',
    translations: {
      de: 'Diese Funktion ist in dieser Umgebung nicht verfügbar.',
      en: 'This feature is not available in this environment.',
    },
  },
} as const satisfies IErrorRegistry;

/**
 * Merged ErrorCode object for use in this project
 *
 * Contains both core LTNS_* errors and project-specific SRV_* errors.
 *
 * @example
 * ```typescript
 * // Core error
 * throw new UnauthorizedException(ErrorCode.UNAUTHORIZED);
 *
 * // Project error
 * throw new UnprocessableEntityException(ErrorCode.DEMO_ERROR);
 * ```
 */
export const ErrorCode = mergeErrorCodes(ServerErrors);

/**
 * Type for all available error code keys
 */
export type ServerErrorCodeKey = keyof typeof ErrorCode;
