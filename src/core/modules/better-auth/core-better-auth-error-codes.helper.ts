import { ErrorCode } from '../error-code/error-codes';

/**
 * Translate Better-Auth's own error codes into nest-server's `#LTNS_XXXX:` message format.
 *
 * ── Why this exists ────────────────────────────────────────────────────────────
 * Frontends in this stack translate errors by parsing the message for nest-server's marker —
 * `useLtErrorTranslation` matches `/^#([A-Z_]+_\d+):\s*(.+)$/` and nothing else. Better-Auth
 * answers with `{ code: 'INVALID_TOKEN', message: 'Invalid token' }`, which carries no marker, so
 * the parser finds no code and hands the raw string through. The end user is shown English
 * developer text — not as an edge case, but as the NORMAL outcome of every IAM error.
 *
 * That is felt most on the password-reset page: a link that has expired produces `INVALID_TOKEN`,
 * and the person who already cannot sign in is told "Invalid token" in a language the rest of the
 * product does not use.
 *
 * Wrapping the message here fixes it for every consumer at once — including projects that do not
 * use `@lenne.tech/nuxt-extensions` and would otherwise each need their own code table.
 *
 * ── Two rules that keep this safe ──────────────────────────────────────────────
 * 1. The original `code` field is left ALONE. Anything keying on `code` — Better-Auth's own client,
 *    a project's error branch — keeps working. Only the human-facing `message` is rewritten.
 * 2. An unknown code is passed through UNCHANGED. A guessed mapping would show a confident,
 *    wrong sentence, which is worse than an untranslated true one. New codes are added here
 *    deliberately, not inferred.
 *
 * Mapping only where the meaning is unambiguous. Three deliberate absences:
 *
 * - `SESSION_EXPIRED` means "re-authenticate for this sensitive action", which is not what
 *   nest-server's `TOKEN_EXPIRED` ("please sign in again") tells the user to do.
 * - `USER_NOT_FOUND` is an account-enumeration signal. Better-Auth already exposes it as a `code`,
 *   but translating it into the user's language would make the oracle friendlier and more legible
 *   — the opposite direction from the rest of this release, which spent real effort closing the
 *   legacy reset endpoint's equivalent. Left untranslated on purpose.
 * - Anything else Better-Auth may add later. An unmapped code passes through unchanged.
 *
 * `PASSWORD_TOO_SHORT` / `PASSWORD_TOO_LONG` ARE mapped, and their reachability is worth stating
 * because it is narrower than it looks: the lt frontend hashes with `ltSha256` before sending, so
 * every password arrives as 64 hex characters and neither bound is crossed. They remain reachable
 * for a client that does not hash (this is a framework, not only the lt stack) and for a project
 * that configures `minPasswordLength` above 64 — which the middleware reads as a passthrough
 * option, so it is a supported configuration rather than a hypothetical.
 */
const BETTER_AUTH_ERROR_CODE_MAP: Readonly<Record<string, string>> = Object.freeze({
  EMAIL_ALREADY_VERIFIED: ErrorCode.EMAIL_ALREADY_VERIFIED,
  EMAIL_NOT_VERIFIED: ErrorCode.EMAIL_VERIFICATION_REQUIRED,
  INVALID_EMAIL_OR_PASSWORD: ErrorCode.INVALID_CREDENTIALS,
  INVALID_PASSWORD: ErrorCode.INVALID_PASSWORD,
  // Distinct codes, not LINK_INVALID_OR_EXPIRED: Better-Auth answers BOTH with HTTP 400 on
  // `/reset-password`, so a page branching on status alone cannot tell them apart and shows "your
  // link is dead". The user then requests a new link, pastes the same over-long passphrase from
  // their password manager, and fails again — a closed loop that never names the cause.
  PASSWORD_TOO_LONG: ErrorCode.PASSWORD_TOO_LONG,
  PASSWORD_TOO_SHORT: ErrorCode.PASSWORD_TOO_SHORT,
  // NOT ErrorCode.INVALID_TOKEN: that one is the legacy auth service's refresh/session token and
  // reads "sign in again". Every Better-Auth INVALID_TOKEN reaches the user through a LINK in a
  // mail — reset, verification, magic link — and telling somebody who cannot sign in to sign in is
  // the one instruction that helps least.
  INVALID_TOKEN: ErrorCode.LINK_INVALID_OR_EXPIRED,
  // Also NOT ErrorCode.TOKEN_EXPIRED ("please sign in again"), for the same reason as above and
  // with a sharper edge: Better-Auth throws TOKEN_EXPIRED in exactly ONE place — an expired
  // verification LINK (email-verification.mjs:178) — one line above the INVALID_TOKEN it throws
  // for a broken one. Splitting that single user action ("I clicked an old link in my mail") into
  // two opposite instructions would be wrong in the MORE common half, since links expire far more
  // often than they get mangled. Worse, at that point the user is typically not signed in at all,
  // so "sign in again" is a dead end. `LINK_INVALID_OR_EXPIRED` covers expiry in its wording.
  TOKEN_EXPIRED: ErrorCode.LINK_INVALID_OR_EXPIRED,
  USER_ALREADY_EXISTS: ErrorCode.EMAIL_ALREADY_EXISTS,
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: ErrorCode.EMAIL_ALREADY_EXISTS,
});

/**
 * The nest-server message for a Better-Auth error code, or `undefined` when it has no mapping.
 *
 * Exported so a project can reuse the same table rather than build a second one that drifts.
 */
export function mapBetterAuthErrorCode(code: unknown): string | undefined {
  return typeof code === 'string' ? BETTER_AUTH_ERROR_CODE_MAP[code] : undefined;
}

/**
 * Rewrite a failed Better-Auth response so its `message` carries nest-server's error marker.
 *
 * Returns the ORIGINAL response object whenever nothing should change — a successful response, a
 * body that is not JSON, or a code with no mapping. That matters: the response body is a stream
 * that can be read once, so handing back an untouched original rather than a rebuilt copy keeps
 * every other consumer of it working.
 *
 * Never throws. An error surfacing from the error-formatting path would replace a useful message
 * with a 500, which is the one outcome worse than an untranslated string.
 */
export async function wrapBetterAuthErrorResponse(response: Response): Promise<Response> {
  if (response.ok) {
    return response;
  }

  // A redirect is not ours to rewrite. Better-Auth reports some failures by REDIRECTING to the
  // caller's `callbackURL` with `?error=<CODE>` (see `redirectOnError` in its email-verification
  // route) — a 3xx with no JSON body, so there is no message to translate. Rewriting the code in
  // that query string instead would invent a second contract on top of Better-Auth's documented
  // one, which the frontend reads. Those cases stay untranslated on purpose, and the frontend maps
  // `?error=` itself.
  if (response.status >= 300 && response.status < 400) {
    return response;
  }

  try {
    const body = await response.clone().json();
    const mapped = mapBetterAuthErrorCode(body?.code);

    // No mapping, or a message that already carries the marker (a nest-server exception that
    // travelled through Better-Auth): leave it exactly as it is.
    if (!mapped || typeof body?.message !== 'string' || body.message.startsWith('#')) {
      return response;
    }

    const headers = new Headers();

    // `set-cookie` FIRST, and via getSetCookie/append rather than the forEach below. `forEach`
    // yields each cookie separately and `set()` overwrites, so a response carrying two of them
    // would keep only the last. Better-Auth CLEARS session and 2FA cookies on several failure
    // paths — exactly the responses this function rewrites — so collapsing them leaves a stale
    // credential in the browser. `sendWebResponse` uses getSetCookie() for the same reason.
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      headers.append('set-cookie', cookie);
    }

    response.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      // content-length: the rewritten body has a different length, and a stale one truncates the
      // response. set-cookie: already appended above, and `set()` here would undo that.
      if (lower !== 'content-length' && lower !== 'set-cookie') {
        headers.set(key, value);
      }
    });

    return new Response(JSON.stringify({ ...body, message: mapped }), {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  } catch {
    // Not JSON, or an unreadable body. The original is still the best answer available.
    return response;
  }
}
