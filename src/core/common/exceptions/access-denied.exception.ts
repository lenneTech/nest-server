import { ForbiddenException, UnauthorizedException } from '@nestjs/common';

import { ErrorCode } from '../../modules/error-code/error-codes';

/**
 * Creates the access error that matches the requester's auth state (RFC 9110, mirrors RolesGuard):
 * **403 Forbidden** for authenticated requesters (a permission problem) and **401 Unauthorized**
 * only when the requester is not authenticated.
 *
 * Frontends commonly treat 401 as "session expired" and auto-logout (the `@lenne.tech/nuxt-extensions`
 * auth interceptor patches `$fetch`/`fetch` globally and does exactly this), so a mere permission
 * error must never surface as 401 — it would kick a logged-in user out of the whole app.
 *
 * This is a **factory, not a class**, on purpose: it returns the *native* Nest exceptions, so
 * `instanceof ForbiddenException` / `instanceof UnauthorizedException` and `@Catch(...)` filters in
 * consuming projects keep working, and the REST wire body (which `HttpExceptionLogFilter` builds via
 * `{ ...exception }`, including `name`) stays identical to what it was before. A custom
 * `HttpException` subclass would satisfy neither.
 *
 * The default messages are the same translatable `ErrorCode`s the role guards throw (`#LTNS_xxxx:`
 * marker → resolvable by the frontend error-translation layer). Pass an explicit `message` only
 * where a raw string is genuinely required; prefer logging request-specific detail (class names,
 * field names) over returning it to the client.
 *
 * @param user The **requesting** user (never the target object). The decision key is `user.id`: an
 *   id that is present — even a falsy one like `0` or `''` — counts as authenticated, while
 *   `undefined`, `null` or no user at all does not. This mirrors how `check()` defines "logged in"
 *   (`S_USER` requires `user?.id`).
 * @param message Overrides the default `ErrorCode`. Omit it to stay consistent with `RolesGuard`.
 *
 * @example
 * // 403 for an authenticated user who lacks a right, 401 for an anonymous requester:
 * throw accessDeniedException(currentUser);
 *
 * @see src/core/modules/auth/guards/roles.guard.ts — the pre-existing 401/403 pattern this mirrors
 * @see migration-guides/11.27.7-to-11.28.0.md
 */
export function accessDeniedException(
  user: { id?: unknown } | null | undefined,
  message?: string,
): ForbiddenException | UnauthorizedException {
  // A present id means authenticated. `!!user?.id` would misjudge falsy-but-real ids (0, '') as
  // anonymous and hand an authenticated user the very 401 this mechanism exists to avoid.
  const authenticated = user?.id !== undefined && user?.id !== null;

  return authenticated
    ? new ForbiddenException(message ?? ErrorCode.ACCESS_DENIED)
    : new UnauthorizedException(message ?? ErrorCode.UNAUTHORIZED);
}
