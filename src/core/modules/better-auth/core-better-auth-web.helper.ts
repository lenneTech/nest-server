import { Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { Request, Response } from 'express';

import { isSessionToken } from './core-better-auth-token.helper';

/**
 * Cookie names used by Better Auth and nest-server
 *
 * ## Cookie Strategy (v11.12+)
 *
 * Only the minimum required cookies are used:
 * - `{basePath}.session_token` (e.g., `iam.session_token`) - Better-Auth native (ALWAYS)
 * - `token` - Legacy compatibility (only if Legacy Auth active)
 */
export const BETTER_AUTH_COOKIE_NAMES = {
  /** Legacy nest-server token cookie */
  TOKEN: 'token',
} as const;

/**
 * Maximum body size for streaming requests (1MB).
 * Prevents DoS attacks via large request bodies.
 */
export const MAX_BODY_SIZE = 1024 * 1024;

/**
 * Options for converting Express Request to Web Standard Request
 */
export interface ToWebRequestOptions {
  /** Base path for cookie names (e.g., 'iam') */
  basePath?: string;
  /** Base URL for constructing the full URL */
  baseUrl: string;
  /** Logger instance for debug output */
  logger?: Logger;
  /** Secret for signing cookies (if provided, cookies will be signed) */
  secret?: string;
  /** Optional session token to inject into headers */
  sessionToken?: null | string;
}

/**
 * Converts Express-style headers to Web API Headers.
 *
 * This is used across the module wherever we need to call Better-Auth APIs
 * that expect Web Standard Headers (Resolver, Controller, Service, toWebRequest).
 *
 * @param headers - Express-style headers (Record with string or string[] values)
 * @returns Web API Headers instance
 */
export function convertExpressHeaders(headers: Record<string, string | string[] | undefined>): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      result.set(key, value);
    } else if (Array.isArray(value)) {
      result.set(key, value.join(', '));
    }
  }
  return result;
}

/**
 * Extracts the session token from Express request cookies or Authorization header.
 *
 * Cookie priority (v11.12+):
 * 1. Authorization: Bearer header (if session token, not JWT)
 * 2. `{basePath}.session_token` (e.g., `iam.session_token`) - Better-Auth native
 * 3. `token` - Legacy nest-server cookie
 *
 * @param req - Express request
 * @param basePath - Base path for cookie names (e.g., '/iam' or 'iam')
 * @returns Session token or null if not found
 */
export function extractSessionToken(req: Request, basePath: string = 'iam'): null | string {
  // Check Authorization header for session tokens (but NOT JWTs).
  // JWTs (3 dot-separated parts) are handled separately by the session middleware.
  // Returning a JWT here would cause toWebRequest() to overwrite valid session
  // cookies with the JWT, breaking Better Auth's session lookup.
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const bearerToken = authHeader.substring(7);
    if (isSessionToken(bearerToken)) {
      return bearerToken;
    }
  }

  // Normalize basePath (remove leading slash, replace slashes with dots)
  const normalizedBasePath = basePath.replace(/^\//, '').replace(/\//g, '.');

  // Cookie names to check (in order of priority)
  // v11.12+: Only native Better-Auth cookie and legacy token
  const cookieNames = [
    `${normalizedBasePath}.session_token`, // Better-Auth native (PRIMARY)
    BETTER_AUTH_COOKIE_NAMES.TOKEN, // Legacy nest-server cookie
  ];

  // Try to get cookies from req.cookies (parsed by cookie-parser) or from header
  const cookies = (req as any).cookies || parseCookieHeader(req.headers.cookie);

  for (const name of cookieNames) {
    const token = cookies?.[name];
    if (token && typeof token === 'string') {
      // If the cookie value is signed (TOKEN.SIGNATURE format), extract the raw token.
      // Better Auth signs session cookies; the DB stores only the raw token.
      if (isAlreadySigned(token)) {
        return token.split('.')[0];
      }
      return token;
    }
  }

  return null;
}

/**
 * Checks if a cookie value appears to be already signed.
 *
 * A signed cookie has the format: `value.base64signature` where the signature
 * is a base64-encoded string. This function checks if the value contains a dot
 * followed by what looks like a base64 signature (not a JWT which has 2 dots).
 *
 * Note: This also handles URL-encoded signed cookies.
 *
 * @param value - The cookie value to check
 * @returns true if the value appears to be already signed
 */
export function isAlreadySigned(value: string): boolean {
  if (!value) {
    return false;
  }

  // First, try to URL-decode the value (signed cookies from signCookieValue are URL-encoded)
  let decodedValue = value;
  try {
    decodedValue = decodeURIComponent(value);
  } catch {
    // If decoding fails, use the original value
  }

  // A JWT has exactly 2 dots (header.payload.signature)
  // A signed cookie has exactly 1 dot (value.signature)
  const dotCount = (decodedValue.match(/\./g) || []).length;

  if (dotCount !== 1) {
    return false;
  }

  // Check if the part after the dot looks like a base64 signature
  const lastDotIndex = decodedValue.lastIndexOf('.');
  const potentialSignature = decodedValue.substring(lastDotIndex + 1);

  // Base64 signature should be non-empty and contain only valid base64 characters
  // HMAC-SHA256 base64 signatures are typically 44 characters (32 bytes -> 44 base64 chars with padding)
  const base64Regex = /^[A-Za-z0-9+/]+=*$/;
  return potentialSignature.length >= 20 && base64Regex.test(potentialSignature);
}

/**
 * Parses a Cookie header string into an object.
 *
 * @param cookieHeader - The Cookie header string
 * @returns Object mapping cookie names to values
 */
export function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) {
    return {};
  }

  const cookies: Record<string, string> = {};
  const pairs = cookieHeader.split(';');

  for (const pair of pairs) {
    const [name, ...valueParts] = pair.trim().split('=');
    if (name && valueParts.length > 0) {
      const rawValue = valueParts.join('=').trim();
      // URL-decode cookie values (standard behavior matching cookie-parser/npm cookie package)
      // Express's res.cookie() URL-encodes values, so we must decode them when parsing
      try {
        cookies[name.trim()] = decodeURIComponent(rawValue);
      } catch {
        cookies[name.trim()] = rawValue;
      }
    }
  }

  return cookies;
}

/**
 * Sends a Web Standard Response as an Express response.
 *
 * This converts the Fetch API Response object back to Express format,
 * preserving headers, status code, and body.
 *
 * @param res - Express response
 * @param webResponse - Web Standard Response
 */
export async function sendWebResponse(res: Response, webResponse: globalThis.Response): Promise<void> {
  // Set status code
  res.status(webResponse.status);

  // Handle Set-Cookie headers separately
  // Headers.forEach() either combines Set-Cookie values (invalid for browsers)
  // or overwrites previous values with setHeader(). Use getSetCookie() instead.
  // IMPORTANT: Merge with any existing Set-Cookie headers (e.g., from res.cookie() calls)
  // to avoid overwriting compatibility cookies set before sendWebResponse is called.
  const setCookieHeaders = webResponse.headers.getSetCookie?.() || [];
  if (setCookieHeaders.length > 0) {
    const existing = res.getHeader('set-cookie');
    const existingHeaders = existing ? (Array.isArray(existing) ? existing.map(String) : [String(existing)]) : [];
    res.setHeader('set-cookie', [...existingHeaders, ...setCookieHeaders]);
  }

  // Copy other headers
  webResponse.headers.forEach((value, key) => {
    // Skip certain headers that Express handles differently
    const lowerKey = key.toLowerCase();
    if (lowerKey === 'set-cookie' || lowerKey === 'content-encoding' || lowerKey === 'transfer-encoding') {
      return;
    }
    res.setHeader(key, value);
  });

  // Send body
  if (webResponse.body) {
    const reader = webResponse.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  res.end();
}

/**
 * Signs a cookie value using HMAC-SHA256.
 *
 * Better Auth expects signed cookies in the format: `${value}.${signature}`
 * where the signature is a base64-encoded HMAC-SHA256 hash of the value.
 *
 * @param value - The raw cookie value to sign
 * @param secret - The secret to use for signing
 * @param urlEncode - Whether to URL-encode the result (default: false)
 *                    Set to true when building cookie header strings manually.
 *                    Set to false when using Express res.cookie() which encodes automatically.
 * @returns The signed cookie value
 * @throws Error if secret is not provided
 */
export function signCookieValue(value: string, secret: string, urlEncode = false): string {
  if (!secret) {
    throw new Error('Cannot sign cookie: Better Auth secret is not configured');
  }

  const signature = crypto.createHmac('sha256', secret).update(value).digest('base64');
  const signedValue = `${value}.${signature}`;
  return urlEncode ? encodeURIComponent(signedValue) : signedValue;
}

/**
 * Signs a cookie value only if it's not already signed.
 *
 * This prevents double-signing which would make the cookie invalid.
 *
 * @param value - The cookie value to potentially sign
 * @param secret - The secret to use for signing
 * @param urlEncode - Whether to URL-encode the result (default: true for backwards compatibility)
 *                    Set to true when building cookie header strings manually.
 *                    Set to false when using Express res.cookie() which encodes automatically.
 * @param logger - Optional logger for debug output
 * @returns The signed cookie value or the original if already signed
 */
export function signCookieValueIfNeeded(value: string, secret: string, urlEncode = true, logger?: Logger): string {
  if (isAlreadySigned(value)) {
    logger?.debug?.('Cookie value appears to be already signed, skipping signing');
    // Return URL-encoded if requested and not already encoded
    if (urlEncode) {
      return value.includes('%') ? value : encodeURIComponent(value);
    }
    return value.includes('%') ? decodeURIComponent(value) : value;
  }
  return signCookieValue(value, secret, urlEncode);
}

/**
 * Converts an Express Request to a Web Standard Request.
 *
 * Better Auth uses the Fetch API's Request/Response objects internally.
 * This method converts the Express request (including already-parsed body)
 * to a Web Standard Request that Better Auth can process.
 *
 * @param req - Express request
 * @param options - Conversion options
 * @returns Web Standard Request
 */
export async function toWebRequest(req: Request, options: ToWebRequestOptions): Promise<globalThis.Request> {
  const { basePath, baseUrl, logger, secret, sessionToken } = options;
  const url = new URL(req.originalUrl || req.url, baseUrl);

  // Build headers using shared helper
  const headers = convertExpressHeaders(req.headers as Record<string, string | string[] | undefined>);

  // Inject session token into Authorization header if provided
  // This helps Better Auth find the session via bearer token lookup
  if (sessionToken) {
    headers.set('authorization', `Bearer ${sessionToken}`);

    const normalizedBasePath = basePath?.replace(/^\//, '').replace(/\//g, '.') || 'iam';
    const primaryCookieName = `${normalizedBasePath}.session_token`;
    const existingCookieString = headers.get('cookie') || '';

    // Check if the request already has a signed session cookie.
    // If so, preserve the original Cookie header to avoid re-encoding issues.
    // The original cookie was signed by setSessionCookies() or Better Auth and is
    // already in the correct format that Better Auth's cookie parser expects.
    const hasExistingSessionCookie = existingCookieString.includes(`${primaryCookieName}=`);

    if (hasExistingSessionCookie) {
      // Original Cookie header already contains a session cookie - keep it as-is.
      // Better Auth can read the original signed cookie directly.
      // Only add legacy token cookie if missing.
      if (!existingCookieString.includes(`${BETTER_AUTH_COOKIE_NAMES.TOKEN}=`)) {
        headers.set('cookie', `${existingCookieString}; ${BETTER_AUTH_COOKIE_NAMES.TOKEN}=${sessionToken}`);
      }
    } else {
      // No session cookie in request (e.g., JWT/bearer mode or Authorization header only).
      // Create a signed cookie for Better Auth's native handler.
      if (secret) {
        const signedToken = signCookieValue(sessionToken, secret, true);
        let newCookieString = existingCookieString
          ? `${existingCookieString}; ${primaryCookieName}=${signedToken}`
          : `${primaryCookieName}=${signedToken}`;

        // Add legacy token cookie if not present
        if (!existingCookieString.includes(`${BETTER_AUTH_COOKIE_NAMES.TOKEN}=`)) {
          newCookieString += `; ${BETTER_AUTH_COOKIE_NAMES.TOKEN}=${sessionToken}`;
        }

        headers.set('cookie', newCookieString);
      } else {
        logger?.warn('No Better Auth secret configured - cookies will not be signed');
      }
    }
  }

  // Build request options
  const init: RequestInit = {
    headers,
    method: req.method,
  };

  // Handle body for non-GET/HEAD requests
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // Check if body was already parsed by NestJS/Express
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
      // Body was parsed - reconstruct it as JSON
      init.body = JSON.stringify(req.body);
      headers.set('content-type', 'application/json');
    } else if (req.readable) {
      // Body wasn't parsed - stream it directly (ideal case)
      // This happens when the middleware runs before body-parser
      const chunks: Buffer[] = [];
      let totalSize = 0;
      for await (const chunk of req) {
        totalSize += chunk.length;
        if (totalSize > MAX_BODY_SIZE) {
          throw new Error(`Request body too large (max ${MAX_BODY_SIZE} bytes)`);
        }
        chunks.push(chunk);
      }
      if (chunks.length > 0) {
        init.body = Buffer.concat(chunks);
      }
    }
  }

  return new globalThis.Request(url.toString(), init);
}
