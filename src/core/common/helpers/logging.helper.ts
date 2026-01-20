/**
 * Logging helper functions for safe logging of sensitive data.
 *
 * These functions help mask sensitive information in logs to comply with
 * security best practices and GDPR requirements.
 *
 * @example
 * ```typescript
 * import { maskToken, maskEmail, maskSensitive } from './logging.helper';
 *
 * // Instead of: logger.debug(`Token: ${token}`)
 * logger.debug(`Token: ${maskToken(token)}`);
 *
 * // Instead of: logger.debug(`User: ${user.email}`)
 * logger.debug(`User: ${maskEmail(user.email)}`);
 * ```
 */

/**
 * Checks if the current environment is production.
 * Use this to conditionally skip verbose debug logging in production.
 *
 * @returns true if NODE_ENV is 'production'
 */
export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Masks a cookie header for safe logging.
 * Removes all cookie values, keeping only cookie names.
 *
 * @param cookieHeader - The cookie header string
 * @returns Masked cookie header showing only cookie names
 *
 * @example
 * maskCookieHeader('session=abc123; token=xyz789') // 'session=***; token=***'
 */
export function maskCookieHeader(cookieHeader: null | string | undefined): string {
  if (!cookieHeader) {
    return 'none';
  }
  // Replace cookie values with ***
  return cookieHeader.replace(/=([^;]*)/g, '=***');
}

/**
 * Masks an email address for safe logging.
 * Shows only the first 2 characters of the local part and the domain.
 *
 * @param email - The email to mask
 * @returns Masked email or 'none' if not provided
 *
 * @example
 * maskEmail('john.doe@example.com') // 'jo***@example.com'
 * maskEmail(null) // 'none'
 */
export function maskEmail(email: null | string | undefined): string {
  if (!email) {
    return 'none';
  }
  const atIndex = email.indexOf('@');
  if (atIndex <= 0) {
    return '***';
  }
  const localPart = email.substring(0, atIndex);
  const domain = email.substring(atIndex);
  const visibleChars = Math.min(2, localPart.length);
  return `${localPart.substring(0, visibleChars)}***${domain}`;
}

/**
 * Masks an ObjectId or ID string for safe logging.
 *
 * @param id - The ID to mask
 * @returns Masked ID or 'none' if not provided
 *
 * @example
 * maskId('507f1f77bcf86cd799439011') // '507f***9011'
 */
export function maskId(id: null | string | undefined): string {
  return maskSensitive(id, 4, 4);
}

/**
 * Masks sensitive string data for safe logging.
 * Generic function for any sensitive string.
 *
 * @param value - The value to mask
 * @param visibleStart - Number of characters to show at start (default: 4)
 * @param visibleEnd - Number of characters to show at end (default: 0)
 * @returns Masked value or 'none' if not provided
 *
 * @example
 * maskSensitive('secretpassword123') // 'secr***'
 * maskSensitive('secretpassword123', 2, 2) // 'se***23'
 */
export function maskSensitive(
  value: null | string | undefined,
  visibleStart: number = 4,
  visibleEnd: number = 0,
): string {
  if (!value) {
    return 'none';
  }
  const minLength = visibleStart + visibleEnd + 3; // At least 3 chars for '***'
  if (value.length <= minLength) {
    return '***';
  }
  const start = value.substring(0, visibleStart);
  const end = visibleEnd > 0 ? value.substring(value.length - visibleEnd) : '';
  return `${start}***${end}`;
}

/**
 * Masks a token for safe logging.
 * Shows only the first 4 and last 4 characters.
 *
 * @param token - The token to mask
 * @returns Masked token or 'none' if not provided
 *
 * @example
 * maskToken('abc123xyz789') // 'abc1...9'
 * maskToken(null) // 'none'
 */
export function maskToken(token: null | string | undefined): string {
  if (!token) {
    return 'none';
  }
  if (token.length <= 8) {
    return '***';
  }
  return `${token.substring(0, 4)}...${token.substring(token.length - 4)}`;
}
