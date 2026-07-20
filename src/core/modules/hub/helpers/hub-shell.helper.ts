import { randomBytes } from 'crypto';

/**
 * Pure helpers for the Hub's self-contained HTML shell: escaping, CSP nonce handling and the
 * response security-header set. Kept free of Express/Nest types so they are trivially unit-testable
 * and reusable from both the page controller and the email-preview route.
 */

/** Placeholder written into the shell template; replaced per-request by {@link injectNonce}. */
export const HUB_NONCE_PLACEHOLDER = '__CSP_NONCE__';

// Unicode line/paragraph separators. Built via fromCharCode so the source file stays pure ASCII —
// a literal U+2028/U+2029 in a regex literal would itself terminate the line and break parsing.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/** Escape the five HTML-significant characters. Every server-provided value in the shell goes through this. */
export function escapeHtml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escape a value for embedding inside a `<script>` JS string literal. Escapes backslash, single
 * quote and the `<` character (as `<`) so a `</script>` sequence in the data cannot terminate
 * the surrounding tag. Also escapes U+2028 / U+2029, which are literal line terminators inside a
 * JS string and would otherwise break the script (or enable injection) despite looking like text.
 */
export function escapeJsString(value: string): string {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/</g, '\\u003c')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .split(LINE_SEPARATOR)
    .join('\\u2028')
    .split(PARAGRAPH_SEPARATOR)
    .join('\\u2029');
}

/** Generate a fresh per-request CSP nonce. */
export function generateNonce(): string {
  return randomBytes(16).toString('base64');
}

/** Replace every {@link HUB_NONCE_PLACEHOLDER} in a pre-built shell string with the actual nonce. */
export function injectNonce(html: string, nonce: string): string {
  return html.split(HUB_NONCE_PLACEHOLDER).join(nonce);
}

/**
 * Build the strict Content-Security-Policy for a Hub HTML response. `default-src 'none'` denies
 * everything by default; scripts and styles are allowed only via the per-request nonce (plus `'self'`
 * for the shared hub.js bundle). No `unsafe-inline`, no external origins.
 */
export function buildHubCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' 'self'`,
    `style-src 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

/**
 * The full response header set for Hub responses.
 *
 * @param nonce - the per-request CSP nonce
 * @param opts.cacheable - when true, use a long-lived immutable cache (for the versioned hub.js
 *   bundle); otherwise `no-store` (HTML pages and JSON sidecars must never be cached)
 */
export function buildHubSecurityHeaders(nonce: string, opts?: { cacheable?: boolean }): Record<string, string> {
  return {
    'Cache-Control': opts?.cacheable ? 'private, max-age=86400, immutable' : 'no-store',
    'Content-Security-Policy': buildHubCsp(nonce),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}
