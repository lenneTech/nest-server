import { describe, expect, it } from 'vitest';

import {
  mapBetterAuthErrorCode,
  wrapBetterAuthErrorResponse,
} from '../../src/core/modules/better-auth/core-better-auth-error-codes.helper';
import { ErrorCode } from '../../src/core/modules/error-code/error-codes';

/**
 * Better-Auth answers with its own vocabulary (`{ code: 'INVALID_TOKEN', message: 'Invalid token' }`),
 * and the frontends in this stack translate by parsing nest-server's marker — `#LTNS_XXXX:` and
 * nothing else. Without a translation step the end user is shown English developer text, and not
 * as an edge case: it is what EVERY IAM error produced.
 *
 * It bites hardest exactly where it can least be afforded. An expired password-reset link answers
 * `INVALID_TOKEN`, so the person who already cannot sign in is told "Invalid token" in a language
 * the rest of the product does not use.
 *
 * The assertions below are therefore about two things in equal measure: that a known code IS
 * translated, and that everything else is left strictly alone.
 *
 * @regression   11.38.0 — Better-Auth error messages reached the client unwrapped, so
 *   `useLtErrorTranslation` found no code and passed the raw English string through to the user.
 * @seen-failing Two registered mutations in tests/regression-mutations.json:
 *     better-auth-errors-not-wrapped                returns the response untouched, i.e. restores
 *                                                   the raw pass-through
 *     better-auth-expired-link-says-sign-in-again   points TOKEN_EXPIRED back at the session
 *                                                   message, so an expired LINK tells the user to
 *                                                   sign in again
 *     error-wrapper-collapses-set-cookie            drops the getSetCookie/append rebuild, so a
 *                                                   cookie CLEAR on a failure path is discarded
 */
describe('Better-Auth error code mapping', () => {
  const errorResponse = (body: unknown, status = 400): Response =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status });

  describe('mapBetterAuthErrorCode', () => {
    it('maps the code an expired reset link produces to the LINK message, not the session one', () => {
      // The case this whole helper was written for — and the distinction that makes it useful.
      // ErrorCode.INVALID_TOKEN is the legacy auth service's refresh/session token and reads
      // "sign in again", which is the least helpful thing to tell somebody who cannot sign in.
      expect(mapBetterAuthErrorCode('INVALID_TOKEN')).toBe(ErrorCode.LINK_INVALID_OR_EXPIRED);
      expect(mapBetterAuthErrorCode('INVALID_TOKEN')).not.toBe(ErrorCode.INVALID_TOKEN);
    });

    it('maps the sign-in and sign-up codes a user meets most often', () => {
      expect(mapBetterAuthErrorCode('INVALID_EMAIL_OR_PASSWORD')).toBe(ErrorCode.INVALID_CREDENTIALS);
      expect(mapBetterAuthErrorCode('EMAIL_NOT_VERIFIED')).toBe(ErrorCode.EMAIL_VERIFICATION_REQUIRED);
      expect(mapBetterAuthErrorCode('USER_ALREADY_EXISTS')).toBe(ErrorCode.EMAIL_ALREADY_EXISTS);
    });

    it('maps TOKEN_EXPIRED to the LINK message too, not to the session one', () => {
      // Better-Auth throws TOKEN_EXPIRED in exactly one place: an expired verification LINK
      // (email-verification.mjs:178), one line above the INVALID_TOKEN it throws for a broken one.
      // Both are the same user action — clicking an old link in a mail — so they must give the
      // same advice. ErrorCode.TOKEN_EXPIRED says "sign in again", which at that moment is usually
      // a dead end: the user is not signed in, and expiry is the MORE common of the two halves.
      expect(mapBetterAuthErrorCode('TOKEN_EXPIRED')).toBe(ErrorCode.LINK_INVALID_OR_EXPIRED);
      expect(mapBetterAuthErrorCode('TOKEN_EXPIRED')).not.toBe(ErrorCode.TOKEN_EXPIRED);
    });

    it('gives the same answer for a broken and an expired link', () => {
      // The property that matters, stated directly: one user action, one instruction.
      expect(mapBetterAuthErrorCode('INVALID_TOKEN')).toBe(mapBetterAuthErrorCode('TOKEN_EXPIRED'));
    });

    it('maps both password-length codes to their own message, not to the link one', () => {
      // Better-Auth answers these with the same HTTP 400 as an invalid token, so a page branching
      // on status alone shows "your link is dead". The user then requests a new link, pastes the
      // same password, and fails again — a closed loop that never names the cause.
      expect(mapBetterAuthErrorCode('PASSWORD_TOO_LONG')).toBe(ErrorCode.PASSWORD_TOO_LONG);
      expect(mapBetterAuthErrorCode('PASSWORD_TOO_SHORT')).toBe(ErrorCode.PASSWORD_TOO_SHORT);
      expect(mapBetterAuthErrorCode('PASSWORD_TOO_LONG')).not.toBe(ErrorCode.LINK_INVALID_OR_EXPIRED);
    });

    it('leaves USER_NOT_FOUND untranslated, deliberately', () => {
      // It is an account-enumeration signal. Better-Auth already exposes it as a `code`, but
      // translating it would make the oracle friendlier and more legible — the opposite direction
      // from the rest of this release, which closed the legacy endpoint's equivalent.
      expect(mapBetterAuthErrorCode('USER_NOT_FOUND')).toBeUndefined();
    });

    it('returns undefined for an unmapped code instead of guessing', () => {
      // A guessed mapping shows a confident, wrong sentence. That is worse than an untranslated
      // true one, so silence is the correct answer here.
      expect(mapBetterAuthErrorCode('SESSION_EXPIRED')).toBeUndefined();
      expect(mapBetterAuthErrorCode('SOME_FUTURE_CODE')).toBeUndefined();
    });

    it('survives a non-string code without throwing', () => {
      for (const value of [undefined, null, 42, {}, []]) {
        expect(mapBetterAuthErrorCode(value)).toBeUndefined();
      }
    });
  });

  describe('wrapBetterAuthErrorResponse', () => {
    it('rewrites the message of a mapped error', async () => {
      const wrapped = await wrapBetterAuthErrorResponse(
        errorResponse({ code: 'INVALID_TOKEN', message: 'Invalid token' }),
      );
      const body = await wrapped.json();

      expect(body.message).toBe(ErrorCode.LINK_INVALID_OR_EXPIRED);
      // The marker is the entire point — it is what the frontend parser looks for.
      expect(body.message.startsWith('#LTNS_')).toBe(true);
    });

    it('leaves the original `code` field untouched', async () => {
      // Anything branching on `code` — Better-Auth's own client, a project's error handling —
      // must keep working. Only the human-facing message is ours to change.
      const wrapped = await wrapBetterAuthErrorResponse(
        errorResponse({ code: 'INVALID_TOKEN', message: 'Invalid token' }),
      );

      expect((await wrapped.json()).code).toBe('INVALID_TOKEN');
    });

    it('preserves status and content type', async () => {
      // A MAPPED code on purpose: an unmapped one comes back by identity, and the assertion would
      // then hold without the rebuild ever running.
      const wrapped = await wrapBetterAuthErrorResponse(
        errorResponse({ code: 'INVALID_TOKEN', message: 'Invalid token' }, 404),
      );

      expect(wrapped.status).toBe(404);
      expect(wrapped.headers.get('content-type')).toBe('application/json');
    });

    it('drops a stale content-length, which would truncate the rewritten body', async () => {
      // The rewritten message is longer than the original. Carrying the old length over would cut
      // the JSON off mid-string, and the client would see a parse error instead of any message.
      const original = new Response(JSON.stringify({ code: 'INVALID_TOKEN', message: 'Invalid token' }), {
        headers: { 'content-length': '48', 'content-type': 'application/json' },
        status: 400,
      });

      const wrapped = await wrapBetterAuthErrorResponse(original);

      expect(wrapped.headers.get('content-length')).toBeNull();
      await expect(wrapped.json()).resolves.toMatchObject({ code: 'INVALID_TOKEN' });
    });

    it('returns a successful response by identity', async () => {
      // The happy path must not be rebuilt: the body is a stream that can be read once, and every
      // later branch in the middleware still needs it.
      const ok = new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });

      expect(await wrapBetterAuthErrorResponse(ok)).toBe(ok);
    });

    it('returns an unmapped error by identity', async () => {
      const unmapped = errorResponse({ code: 'SESSION_EXPIRED', message: 'Session expired.' });

      expect(await wrapBetterAuthErrorResponse(unmapped)).toBe(unmapped);
    });

    it('does not double-wrap a message that already carries the marker', async () => {
      // A nest-server exception that travelled out through Better-Auth. Wrapping it again would
      // produce `#LTNS_0003: #LTNS_0100: …`, which the frontend regex would then fail to parse.
      const already = errorResponse({ code: 'INVALID_TOKEN', message: ErrorCode.UNAUTHORIZED });

      expect(await wrapBetterAuthErrorResponse(already)).toBe(already);
    });

    it('preserves EVERY Set-Cookie header, not just the last one', async () => {
      // `Headers.forEach` yields each cookie separately and `set()` overwrites, so a naive rebuild
      // keeps only the last. Better-Auth CLEARS session and 2FA cookies on exactly the failure
      // paths this function rewrites — collapsing them leaves a stale credential in the browser.
      const original = new Response(JSON.stringify({ code: 'INVALID_TOKEN', message: 'Invalid token' }), {
        headers: { 'content-type': 'application/json' },
        status: 400,
      });
      original.headers.append('set-cookie', 'session=; Max-Age=0; Path=/');
      original.headers.append('set-cookie', 'two_factor=; Max-Age=0; Path=/');

      const wrapped = await wrapBetterAuthErrorResponse(original);

      expect(wrapped.headers.getSetCookie()).toEqual(['session=; Max-Age=0; Path=/', 'two_factor=; Max-Age=0; Path=/']);
      expect(wrapped.headers.get('content-type')).toBe('application/json');
    });

    it('returns a redirect untouched, because there is no message in one', async () => {
      // Better-Auth reports some failures by redirecting to `callbackURL?error=<CODE>` instead of
      // answering with a body. There is nothing to translate there, and rewriting the code in that
      // query string would invent a second contract on top of Better-Auth's documented one. This
      // is a deliberate boundary of the wrapper, so it is asserted rather than left to the JSON
      // parse happening to fail.
      const redirect = new Response(null, {
        headers: { location: 'https://example.com/auth/verify-email?error=TOKEN_EXPIRED' },
        status: 302,
      });

      expect(await wrapBetterAuthErrorResponse(redirect)).toBe(redirect);
    });

    it('returns a non-JSON error body untouched instead of throwing', async () => {
      // An error raised while FORMATTING an error would replace a useful message with a 500 —
      // the one outcome worse than an untranslated string.
      const html = new Response('<html>gateway timeout</html>', { status: 504 });

      expect(await wrapBetterAuthErrorResponse(html)).toBe(html);
    });
  });
});
