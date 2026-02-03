import { Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { Request, Response } from 'express';

/**
 * Cookie names used by Better Auth and nest-server
 */
export const BETTER_AUTH_COOKIE_NAMES = {
  /** Better Auth's default session token cookie */
  BETTER_AUTH_SESSION: 'better-auth.session_token',
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
 * Extracts the session token from Express request cookies or Authorization header.
 *
 * Checks multiple cookie names for compatibility with different configurations:
 * 1. `{basePath}.session_token` - Based on configured basePath (e.g., iam.session_token)
 * 2. `better-auth.session_token` - Better Auth default
 * 3. `token` - Legacy nest-server cookie
 * 4. Authorization: Bearer header
 *
 * @param req - Express request
 * @param basePath - Base path for cookie names (e.g., '/iam' or 'iam')
 * @returns Session token or null if not found
 */
export function extractSessionToken(req: Request, basePath: string = 'iam'): null | string {
  // Check Authorization header first
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  // Normalize basePath (remove leading slash, replace slashes with dots)
  const normalizedBasePath = basePath.replace(/^\//, '').replace(/\//g, '.');

  // Cookie names to check (in order of priority)
  const cookieNames = [
    `${normalizedBasePath}.session_token`, // Based on configured basePath
    BETTER_AUTH_COOKIE_NAMES.BETTER_AUTH_SESSION, // Better Auth default
    BETTER_AUTH_COOKIE_NAMES.TOKEN, // Legacy nest-server cookie
  ];

  // Try to get cookies from req.cookies (parsed by cookie-parser) or from header
  const cookies = (req as any).cookies || parseCookieHeader(req.headers.cookie);

  for (const name of cookieNames) {
    const token = cookies?.[name];
    if (token && typeof token === 'string') {
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
      cookies[name.trim()] = valueParts.join('=').trim();
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

  // Copy headers
  webResponse.headers.forEach((value, key) => {
    // Skip certain headers that Express handles differently
    const lowerKey = key.toLowerCase();
    if (lowerKey === 'content-encoding' || lowerKey === 'transfer-encoding') {
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
 * @returns The signed cookie value (URL-encoded)
 * @throws Error if secret is not provided
 */
export function signCookieValue(value: string, secret: string): string {
  if (!secret) {
    throw new Error('Cannot sign cookie: Better Auth secret is not configured');
  }

  const signature = crypto.createHmac('sha256', secret).update(value).digest('base64');
  const signedValue = `${value}.${signature}`;
  return encodeURIComponent(signedValue);
}

/**
 * Signs a cookie value only if it's not already signed.
 *
 * This prevents double-signing which would make the cookie invalid.
 *
 * @param value - The cookie value to potentially sign
 * @param secret - The secret to use for signing
 * @param logger - Optional logger for debug output
 * @returns The signed cookie value (URL-encoded) or the original if already signed
 */
export function signCookieValueIfNeeded(value: string, secret: string, logger?: Logger): string {
  if (isAlreadySigned(value)) {
    logger?.debug?.('Cookie value appears to be already signed, skipping signing');
    // Return URL-encoded to match signCookieValue behavior
    return value.includes('%') ? value : encodeURIComponent(value);
  }
  return signCookieValue(value, secret);
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

  // Build headers
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') {
      headers.set(key, value);
    } else if (Array.isArray(value)) {
      headers.set(key, value.join(', '));
    }
  }

  // Inject session token into Authorization header if provided
  // This helps Better Auth find the session via bearer token lookup
  if (sessionToken) {
    headers.set('authorization', `Bearer ${sessionToken}`);

    // Also ensure the session token is in the cookies with PROPER SIGNING
    // IMPORTANT: We must REPLACE unsigned cookies with signed ones, not just add if missing
    const normalizedBasePath = basePath?.replace(/^\//, '').replace(/\//g, '.') || 'iam';
    const existingCookieString = headers.get('cookie') || '';

    // Sign the session token for Better Auth (if secret is provided)
    // IMPORTANT: Only sign if not already signed to prevent double-signing
    let signedToken: string;
    if (secret) {
      signedToken = signCookieValueIfNeeded(sessionToken, secret, logger);
    } else {
      logger?.warn('No Better Auth secret configured - cookies will not be signed');
      signedToken = sessionToken;
    }

    // Cookie names that need signed tokens
    const primaryCookieName = `${normalizedBasePath}.session_token`;
    const sessionCookieNames = [primaryCookieName, BETTER_AUTH_COOKIE_NAMES.BETTER_AUTH_SESSION];

    // Parse existing cookies
    const existingCookies = parseCookieHeader(existingCookieString);

    // Replace session token cookies with signed versions
    for (const cookieName of sessionCookieNames) {
      existingCookies[cookieName] = signedToken;
    }

    // Keep the unsigned token cookie for nest-server compatibility
    if (!existingCookies[BETTER_AUTH_COOKIE_NAMES.TOKEN]) {
      existingCookies[BETTER_AUTH_COOKIE_NAMES.TOKEN] = sessionToken;
    }

    // Rebuild the cookie string
    const newCookieString = Object.entries(existingCookies)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');

    headers.set('cookie', newCookieString);
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
