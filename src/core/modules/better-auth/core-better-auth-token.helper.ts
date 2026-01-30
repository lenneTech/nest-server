/**
 * Token analysis utilities for Better-Auth dual-mode authentication.
 *
 * This helper provides robust token type detection by analyzing JWT payloads
 * instead of relying on fragile heuristics like counting dots in the token string.
 *
 * Token Types:
 * - Legacy JWT: Has 'id' claim but no 'sub' (Passport/JWT strategy)
 * - Better-Auth JWT: Has 'sub' claim (Better-Auth JWT plugin)
 * - Session Token: Opaque token without JWT structure
 */

/**
 * Enum representing the different token types used in the authentication system.
 */
export enum TokenType {
  /** Better-Auth JWT (has 'sub' claim) */
  BETTER_AUTH_JWT = 'better_auth_jwt',
  /** Legacy JWT from Passport/JWT strategy (has 'id' claim, no 'sub') */
  LEGACY_JWT = 'legacy_jwt',
  /** Opaque session token (not a JWT) */
  SESSION_TOKEN = 'session_token',
  /** Unknown or invalid token format */
  UNKNOWN = 'unknown',
}

/**
 * Result of token analysis containing the token type and optional decoded payload.
 */
export interface TokenAnalysisResult {
  /** Decoded JWT payload (only for JWT tokens) */
  payload?: Record<string, unknown>;
  /** The determined token type */
  type: TokenType;
}

/**
 * Analyzes a token and determines its type by examining its structure and payload.
 *
 * This function performs robust token detection by:
 * 1. Checking if the token has JWT structure (3 dot-separated parts)
 * 2. Attempting to decode the JWT payload
 * 3. Differentiating between Legacy JWT ('id' claim) and Better-Auth JWT ('sub' claim)
 *
 * @param token - The token string to analyze
 * @returns TokenAnalysisResult with type and optional decoded payload
 *
 * @example
 * ```typescript
 * const result = analyzeToken(bearerToken);
 * if (result.type === TokenType.LEGACY_JWT) {
 *   // Let Passport handle it
 * } else if (result.type === TokenType.SESSION_TOKEN) {
 *   // Use as Better-Auth session token
 * }
 * ```
 */
export function analyzeToken(token: string): TokenAnalysisResult {
  if (!token || typeof token !== 'string') {
    return { type: TokenType.UNKNOWN };
  }

  const parts = token.split('.');

  // Not a JWT - must be a session token
  if (parts.length !== 3) {
    return { type: TokenType.SESSION_TOKEN };
  }

  // Attempt to decode JWT payload
  try {
    const payloadStr = Buffer.from(parts[1], 'base64url').toString('utf-8');
    const payload = JSON.parse(payloadStr) as Record<string, unknown>;

    // Legacy JWT has 'id' claim (and typically 'deviceId', 'tokenId')
    // but no 'sub' claim
    if (payload.id !== undefined && payload.sub === undefined) {
      return { payload, type: TokenType.LEGACY_JWT };
    }

    // Better-Auth JWT has 'sub' claim
    if (payload.sub !== undefined) {
      return { payload, type: TokenType.BETTER_AUTH_JWT };
    }

    // Has JWT structure but doesn't match known patterns
    return { payload, type: TokenType.UNKNOWN };
  } catch {
    // Failed to decode - might be malformed JWT or session token with dots
    return { type: TokenType.SESSION_TOKEN };
  }
}

/**
 * Extracts user ID from a token based on its type.
 *
 * @param token - The token string
 * @returns The user ID or null if not extractable
 *
 * @example
 * ```typescript
 * const userId = getUserIdFromToken(token);
 * if (userId) {
 *   // Use userId for logging or lookups
 * }
 * ```
 */
export function getUserIdFromToken(token: string): null | string {
  const result = analyzeToken(token);

  if (!result.payload) {
    return null;
  }

  if (result.type === TokenType.LEGACY_JWT) {
    return result.payload.id as null | string;
  }

  if (result.type === TokenType.BETTER_AUTH_JWT) {
    return result.payload.sub as null | string;
  }

  return null;
}

/**
 * Checks if a token is a Better-Auth JWT.
 *
 * Better-Auth JWTs are created by the Better-Auth JWT plugin and
 * have a 'sub' claim containing the user ID.
 *
 * @param token - The token string to check
 * @returns true if the token is a Better-Auth JWT
 */
export function isBetterAuthJwt(token: string): boolean {
  return analyzeToken(token).type === TokenType.BETTER_AUTH_JWT;
}

/**
 * Checks if a token is a JWT (has 3 dot-separated parts and valid structure).
 *
 * @param token - The token string to check
 * @returns true if the token is a JWT (either Legacy or Better-Auth)
 *
 * @example
 * ```typescript
 * if (isJwt(token)) {
 *   // Token needs JWT verification
 * } else {
 *   // Token is a session token, use session lookup
 * }
 * ```
 */
export function isJwt(token: string): boolean {
  const result = analyzeToken(token);
  return result.type === TokenType.LEGACY_JWT || result.type === TokenType.BETTER_AUTH_JWT;
}

/**
 * Checks if a token is a Legacy JWT (Passport/JWT strategy).
 *
 * Legacy JWTs are identified by having an 'id' claim (user ID)
 * but no 'sub' claim. They are typically created by nest-server's
 * CoreAuthService and should be handled by Passport.
 *
 * @param token - The token string to check
 * @returns true if the token is a Legacy JWT
 *
 * @example
 * ```typescript
 * if (isLegacyJwt(token)) {
 *   // Let Passport handle authentication
 *   return next();
 * }
 * ```
 */
export function isLegacyJwt(token: string): boolean {
  return analyzeToken(token).type === TokenType.LEGACY_JWT;
}

/**
 * Checks if a token is a session token (opaque, not a JWT).
 *
 * Session tokens are used by Better-Auth for cookie-based authentication.
 * They don't have JWT structure (3 dot-separated parts with valid payload).
 *
 * @param token - The token string to check
 * @returns true if the token is a session token (not a JWT)
 *
 * @example
 * ```typescript
 * if (isSessionToken(bearerToken)) {
 *   // Use as Better-Auth session token
 *   return bearerToken;
 * }
 * ```
 */
export function isSessionToken(token: string): boolean {
  return analyzeToken(token).type === TokenType.SESSION_TOKEN;
}
