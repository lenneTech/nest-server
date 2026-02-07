/**
 * Lenne Tech Nest Server Error Codes - Structured Registry
 *
 * Single Source of Truth for all error codes, messages, and translations.
 * This file serves as the central registry that:
 * - Defines error codes with human-readable messages
 * - Provides translations for multiple languages
 * - Generates the i18n JSON endpoint automatically
 *
 * API Response Format: #PREFIX_XXXX: Short technical description
 * - # = Marker for machine parsing
 * - PREFIX = LTNS (Lenne Tech Nest Server) or project-specific
 * - XXXX = Unique number within range
 * - : = Separator
 * - Description = English developer-friendly message
 *
 * Error code ranges:
 * - LTNS_0001-LTNS_0099: Authentication errors
 * - LTNS_0100-LTNS_0199: Authorization errors
 * - LTNS_0200-LTNS_0299: User errors
 * - LTNS_0300-LTNS_0399: Validation errors
 * - LTNS_0400-LTNS_0499: Resource errors
 * - LTNS_0500-LTNS_0599: File errors
 * - LTNS_0900-LTNS_0999: Internal errors
 *
 * @example
 * ```typescript
 * import { UnauthorizedException } from '@nestjs/common';
 * import { ErrorCode } from '@lenne.tech/nest-server';
 *
 * throw new UnauthorizedException(ErrorCode.UNAUTHORIZED);
 * // Response: { statusCode: 401, message: "#LTNS_0100: Unauthorized - User is not logged in" }
 * ```
 */

// =====================================================
// Type Definitions
// =====================================================

/**
 * Structure for a single error definition
 */
export interface IErrorDefinition {
  /** Unique error code (e.g., LTNS_0100) */
  code: string;
  /** English developer message */
  message: string;
  /** Translations for end users */
  translations: {
    [locale: string]: string;
    de: string;
    en: string;
  };
}

/**
 * Registry type for error definitions
 */
export type IErrorRegistry = Record<string, IErrorDefinition>;

// =====================================================
// Core Error Registry (Single Source of Truth)
// =====================================================

/**
 * LTNS Error Registry - Contains all core error definitions
 *
 * Each entry includes:
 * - code: The unique identifier
 * - message: English technical description for developers
 * - translations: Localized messages for end users
 *
 * NOTE: Entries are grouped by error code range for maintainability.
 * Do not sort alphabetically - the numeric grouping is intentional.
 */
/* eslint-disable perfectionist/sort-objects */
export const LtnsErrors = {
  // =====================================================
  // Authentication Errors (LTNS_0001-LTNS_0099)
  // =====================================================

  USER_NOT_FOUND: {
    code: 'LTNS_0001',
    message: 'User not found',
    translations: {
      de: 'Benutzer wurde nicht gefunden.',
      en: 'User not found.',
    },
  },

  INVALID_PASSWORD: {
    code: 'LTNS_0002',
    message: 'Invalid password',
    translations: {
      de: 'Das eingegebene Passwort ist ungültig.',
      en: 'The provided password is invalid.',
    },
  },

  INVALID_TOKEN: {
    code: 'LTNS_0003',
    message: 'Invalid or malformed token',
    translations: {
      de: 'Der Token ist ungültig oder fehlerhaft.',
      en: 'The token is invalid or malformed.',
    },
  },

  TOKEN_EXPIRED: {
    code: 'LTNS_0004',
    message: 'Token has expired',
    translations: {
      de: 'Der Token ist abgelaufen. Bitte melden Sie sich erneut an.',
      en: 'The token has expired. Please sign in again.',
    },
  },

  REFRESH_TOKEN_REQUIRED: {
    code: 'LTNS_0005',
    message: 'Refresh token required',
    translations: {
      de: 'Ein Refresh-Token wird benötigt.',
      en: 'A refresh token is required.',
    },
  },

  USER_NOT_VERIFIED: {
    code: 'LTNS_0006',
    message: 'User email not verified',
    translations: {
      de: 'Ihre E-Mail-Adresse wurde noch nicht verifiziert.',
      en: 'Your email address has not been verified yet.',
    },
  },

  // BetterAuth specific errors (LTNS_0010-LTNS_0049)
  INVALID_CREDENTIALS: {
    code: 'LTNS_0010',
    message: 'Invalid credentials',
    translations: {
      de: 'Ungültige Anmeldedaten.',
      en: 'Invalid credentials.',
    },
  },

  INVALID_2FA_CODE: {
    code: 'LTNS_0011',
    message: 'Invalid 2FA code',
    translations: {
      de: 'Der 2FA-Code ist ungültig.',
      en: 'The 2FA code is invalid.',
    },
  },

  TWO_FACTOR_NOT_ENABLED: {
    code: 'LTNS_0012',
    message: 'Two-factor authentication is not enabled',
    translations: {
      de: 'Zwei-Faktor-Authentifizierung ist nicht aktiviert.',
      en: 'Two-factor authentication is not enabled.',
    },
  },

  TWO_FACTOR_NOT_ENABLED_SERVER: {
    code: 'LTNS_0013',
    message: 'Two-factor authentication is not enabled on this server',
    translations: {
      de: 'Zwei-Faktor-Authentifizierung ist auf diesem Server nicht aktiviert.',
      en: 'Two-factor authentication is not enabled on this server.',
    },
  },

  PASSKEY_NOT_ENABLED_SERVER: {
    code: 'LTNS_0014',
    message: 'Passkey authentication is not enabled on this server',
    translations: {
      de: 'Passkey-Authentifizierung ist auf diesem Server nicht aktiviert.',
      en: 'Passkey authentication is not enabled on this server.',
    },
  },

  SIGNUP_FAILED: {
    code: 'LTNS_0015',
    message: 'Sign-up failed',
    translations: {
      de: 'Die Registrierung ist fehlgeschlagen.',
      en: 'Sign-up failed.',
    },
  },

  BETTERAUTH_NOT_INITIALIZED: {
    code: 'LTNS_0016',
    message: 'Better-Auth not initialized',
    translations: {
      de: 'Better-Auth ist nicht initialisiert.',
      en: 'Better-Auth is not initialized.',
    },
  },

  BETTERAUTH_DISABLED: {
    code: 'LTNS_0017',
    message: 'Better-Auth is disabled',
    translations: {
      de: 'Better-Auth ist deaktiviert.',
      en: 'Better-Auth is disabled.',
    },
  },

  BETTERAUTH_API_NOT_AVAILABLE: {
    code: 'LTNS_0018',
    message: 'Better-Auth API not available',
    translations: {
      de: 'Better-Auth API ist nicht verfügbar.',
      en: 'Better-Auth API is not available.',
    },
  },

  TWO_FACTOR_METHOD_NOT_AVAILABLE: {
    code: 'LTNS_0019',
    message: '2FA verification method not available',
    translations: {
      de: '2FA-Verifizierungsmethode ist nicht verfügbar.',
      en: '2FA verification method is not available.',
    },
  },

  RATE_LIMIT_EXCEEDED: {
    code: 'LTNS_0020',
    message: 'Too many requests',
    translations: {
      de: 'Zu viele Anfragen. Bitte versuchen Sie es später erneut.',
      en: 'Too many requests. Please try again later.',
    },
  },

  SIGNUP_TERMS_NOT_ACCEPTED: {
    code: 'LTNS_0021',
    message: 'Terms and privacy policy must be accepted',
    translations: {
      de: 'Die Nutzungsbedingungen und Datenschutzrichtlinie müssen akzeptiert werden.',
      en: 'Terms and privacy policy must be accepted.',
    },
  },

  SIGNUP_MISSING_REQUIRED_FIELDS: {
    code: 'LTNS_0022',
    message: 'Required sign-up fields are missing',
    translations: {
      de: 'Erforderliche Registrierungsfelder fehlen.',
      en: 'Required sign-up fields are missing.',
    },
  },

  EMAIL_VERIFICATION_REQUIRED: {
    code: 'LTNS_0023',
    message: 'Email verification required',
    translations: {
      de: 'Bitte verifizieren Sie Ihre E-Mail-Adresse.',
      en: 'Please verify your email address.',
    },
  },

  EMAIL_VERIFICATION_TOKEN_INVALID: {
    code: 'LTNS_0024',
    message: 'Email verification token is invalid or expired',
    translations: {
      de: 'Der E-Mail-Verifizierungslink ist ungültig oder abgelaufen.',
      en: 'The email verification link is invalid or expired.',
    },
  },

  EMAIL_ALREADY_VERIFIED: {
    code: 'LTNS_0025',
    message: 'Email is already verified',
    translations: {
      de: 'Die E-Mail-Adresse ist bereits verifiziert.',
      en: 'The email address is already verified.',
    },
  },

  SIGNUP_DISABLED: {
    code: 'LTNS_0026',
    message: 'Sign-up is currently disabled',
    translations: {
      de: 'Die Registrierung ist derzeit deaktiviert.',
      en: 'Sign-up is currently disabled.',
    },
  },

  // =====================================================
  // Authorization Errors (LTNS_0100-LTNS_0199)
  // =====================================================

  UNAUTHORIZED: {
    code: 'LTNS_0100',
    message: 'Unauthorized - User is not logged in',
    translations: {
      de: 'Sie sind nicht angemeldet.',
      en: 'You are not logged in.',
    },
  },

  ACCESS_DENIED: {
    code: 'LTNS_0101',
    message: 'Access denied - Insufficient permissions',
    translations: {
      de: 'Zugriff verweigert. Sie haben nicht die erforderlichen Berechtigungen.',
      en: 'Access denied. You do not have the required permissions.',
    },
  },

  RESOURCE_FORBIDDEN: {
    code: 'LTNS_0102',
    message: 'Resource access forbidden',
    translations: {
      de: 'Der Zugriff auf diese Ressource ist nicht erlaubt.',
      en: 'Access to this resource is forbidden.',
    },
  },

  // =====================================================
  // User Errors (LTNS_0200-LTNS_0299)
  // =====================================================

  EMAIL_ALREADY_EXISTS: {
    code: 'LTNS_0200',
    message: 'Email already registered',
    translations: {
      de: 'Diese E-Mail-Adresse ist bereits registriert.',
      en: 'This email address is already registered.',
    },
  },

  USERNAME_ALREADY_EXISTS: {
    code: 'LTNS_0201',
    message: 'Username already taken',
    translations: {
      de: 'Dieser Benutzername ist bereits vergeben.',
      en: 'This username is already taken.',
    },
  },

  // =====================================================
  // Validation Errors (LTNS_0300-LTNS_0399)
  // =====================================================

  VALIDATION_FAILED: {
    code: 'LTNS_0300',
    message: 'Validation failed',
    translations: {
      de: 'Die Validierung ist fehlgeschlagen.',
      en: 'Validation failed.',
    },
  },

  REQUIRED_FIELD_MISSING: {
    code: 'LTNS_0301',
    message: 'Required field missing',
    translations: {
      de: 'Ein erforderliches Feld fehlt.',
      en: 'A required field is missing.',
    },
  },

  INVALID_FIELD_FORMAT: {
    code: 'LTNS_0302',
    message: 'Invalid field format',
    translations: {
      de: 'Das Feldformat ist ungültig.',
      en: 'The field format is invalid.',
    },
  },

  // =====================================================
  // Resource Errors (LTNS_0400-LTNS_0499)
  // =====================================================

  RESOURCE_NOT_FOUND: {
    code: 'LTNS_0400',
    message: 'Resource not found',
    translations: {
      de: 'Die angeforderte Ressource wurde nicht gefunden.',
      en: 'The requested resource was not found.',
    },
  },

  RESOURCE_ALREADY_EXISTS: {
    code: 'LTNS_0401',
    message: 'Resource already exists',
    translations: {
      de: 'Diese Ressource existiert bereits.',
      en: 'This resource already exists.',
    },
  },

  // =====================================================
  // File Errors (LTNS_0500-LTNS_0599)
  // =====================================================

  FILE_NOT_FOUND: {
    code: 'LTNS_0500',
    message: 'File not found',
    translations: {
      de: 'Die Datei wurde nicht gefunden.',
      en: 'The file was not found.',
    },
  },

  FILE_UPLOAD_FAILED: {
    code: 'LTNS_0501',
    message: 'File upload failed',
    translations: {
      de: 'Der Datei-Upload ist fehlgeschlagen.',
      en: 'The file upload failed.',
    },
  },

  FILE_TYPE_NOT_ALLOWED: {
    code: 'LTNS_0502',
    message: 'File type not allowed',
    translations: {
      de: 'Dieser Dateityp ist nicht erlaubt.',
      en: 'This file type is not allowed.',
    },
  },

  // =====================================================
  // Internal Errors (LTNS_0900-LTNS_0999)
  // =====================================================

  INTERNAL_ERROR: {
    code: 'LTNS_0900',
    message: 'Internal server error',
    translations: {
      de: 'Ein interner Serverfehler ist aufgetreten.',
      en: 'An internal server error occurred.',
    },
  },

  SERVICE_UNAVAILABLE: {
    code: 'LTNS_0901',
    message: 'Service temporarily unavailable',
    translations: {
      de: 'Der Dienst ist vorübergehend nicht verfügbar.',
      en: 'The service is temporarily unavailable.',
    },
  },

  LEGACY_AUTH_DISABLED: {
    code: 'LTNS_0902',
    message: 'Legacy authentication is disabled',
    translations: {
      de: 'Die Legacy-Authentifizierung ist deaktiviert. Bitte nutzen Sie die neue Authentifizierung.',
      en: 'Legacy authentication is disabled. Please use the new authentication.',
    },
  },
} as const satisfies IErrorRegistry;
/* eslint-enable perfectionist/sort-objects */

// =====================================================
// Generated ErrorCode Object
// =====================================================

/**
 * Generate formatted error message from definition
 * Format: #CODE: Message
 */
function formatErrorMessage(def: IErrorDefinition): string {
  return `#${def.code}: ${def.message}`;
}

/**
 * Generate ErrorCode object from registry
 * Maps each key to its formatted error string
 */
function generateErrorCodes<T extends IErrorRegistry>(registry: T): { [K in keyof T]: string } {
  const result = {} as { [K in keyof T]: string };
  for (const key of Object.keys(registry) as Array<keyof T>) {
    result[key] = formatErrorMessage(registry[key]);
  }
  return result;
}

/**
 * ErrorCode - Use this in your code with NestJS exceptions
 *
 * @example
 * ```typescript
 * throw new UnauthorizedException(ErrorCode.UNAUTHORIZED);
 * // Response: { statusCode: 401, message: "#LTNS_0100: Unauthorized - User is not logged in" }
 * ```
 */
export const ErrorCode = generateErrorCodes(LtnsErrors);

// =====================================================
// Type Exports
// =====================================================

/**
 * Type for error code keys (readable names like USER_NOT_FOUND)
 */
export type ErrorCodeKey = keyof typeof ErrorCode;

/**
 * Type for all error code formatted strings
 */
export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Type for raw error codes (like LTNS_0100)
 */
export type RawErrorCode = (typeof LtnsErrors)[keyof typeof LtnsErrors]['code'];

// =====================================================
// Helper Functions
// =====================================================

/**
 * Get all error definitions (for i18n endpoint)
 *
 * @returns All error definitions from the registry
 */
export function getAllErrorDefinitions(): typeof LtnsErrors {
  return LtnsErrors;
}

// =====================================================
// Extension Support
// =====================================================

/**
 * Merge project-specific errors with core errors
 *
 * @param projectErrors - Project-specific error registry
 * @returns Merged error codes object
 *
 * @example
 * ```typescript
 * // In your project
 * const ProjectErrors = {
 *   ORDER_NOT_FOUND: {
 *     code: 'PROJ_0001',
 *     message: 'Order not found',
 *     translations: { de: 'Bestellung nicht gefunden.', en: 'Order not found.' }
 *   }
 * } as const satisfies IErrorRegistry;
 *
 * export const ErrorCode = mergeErrorCodes(ProjectErrors);
 * // Contains both LTNS_* and PROJ_* errors
 * ```
 */
export function mergeErrorCodes<T extends IErrorRegistry>(
  projectErrors: T,
): { [K in keyof T | keyof typeof LtnsErrors]: string } {
  return {
    ...ErrorCode,
    ...generateErrorCodes(projectErrors),
  } as { [K in keyof T | keyof typeof LtnsErrors]: string };
}
