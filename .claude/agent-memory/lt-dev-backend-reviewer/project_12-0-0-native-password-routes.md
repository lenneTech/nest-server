---
name: project-12-0-0-native-password-routes
description: 12.0.0 review — PASSWORD_FIELD_PATHS length refusal answered 500 via the API middleware's catch (FIXED same day, catch rethrows HttpException → 400); logThroughNest dropped Error message/stack (FIXED, formatBetterAuthLogArg); WS 4401 refusal verified.
metadata:
  type: project
---

Reviewed the uncommitted 12.0.0 diff on 2026-10-24.

**Reported (High):** `normalizeNativePasswords()` in `core-better-auth-api.middleware.ts` runs inside `use()`'s
`try`, whose `catch` answers EVERY error with `500 { error: 'Authentication handler error' }` + an ERROR log. So the
new plaintext-length refusal on `/iam/change-password` (BadRequestException) became a 500, where Better-Auth itself
answered 400 `PASSWORD_TOO_SHORT`. Reproduced with a scratchpad probe (mocked service, `use()` called directly,
handler never reached, no session needed). The reset routes' identical length check had the same 500 BEFORE this
diff (pre-existing). **Fixed the same day:** the catch rethrows an `HttpException`, Nest's middleware proxy hands it
to the exception filters → 400 with the bounds in the message. Pinned end-to-end in `better-auth-plugins.story.test.ts`
("5. Plugin Error Handling": change-password AND reset-password), mutation `native-password-length-refusal-answered-500`.

**Judged Medium here, fixed anyway by the orchestrator:** `logThroughNest` JSON.stringified extra args, so
Better-Auth's `ctx.logger.error(e.name, e)` / "Failed to run background task:", e printed `TypeError {}` and a
circular arg made the logger throw. Now `formatBetterAuthLogArg()` prints an Error's stack, keeps plain objects as
JSON and falls back to `inspect()`; pinned in `tests/unit/better-auth-logger-routing.spec.ts`, mutation
`better-auth-log-error-args-dropped`. For router-forwarded routes better-call additionally `console.error`s the error.

**Verified sound:** `refuseWsHandshake()` (graphql-ws calls `socket.close(4403)` after `onConnect` returns false; ws
treats close on a CLOSING socket as a no-op); terminus 12 `withTimeout()` overwrites `timeoutMs`, so the health-check
translation keeps 300 ms / configured values; inlined passport `defaultOptions`/`memoize` match upstream.

**How to apply:** when this area changes again, probe the HTTP status of a refused value end-to-end, not the unit
throw — the unit spec `password-field-paths.spec.ts` asserts `toThrow(BadRequestException)`, which hides the 500.
Related: [[review-tree-is-shared-and-mutable]].
