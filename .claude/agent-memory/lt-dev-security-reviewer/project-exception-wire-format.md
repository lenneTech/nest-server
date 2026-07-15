---
name: project-exception-wire-format
description: HttpExceptionLogFilter serializes {...exception} for REST, so a custom HttpException subclass changes the wire body (name/options) and breaks instanceof against native Nest exceptions
metadata:
  type: project
---

Two non-obvious traps when reviewing any new/changed exception class in nest-server.

**1. The REST wire body is `{ ...exception }`, not `getResponse()`.**
`src/core/common/filters/http-exception-log.filter.ts` does
`res.status(status).json({ ...exception })`, and `src/main.ts` registers it via
`useGlobalFilters()` (nest-server-starter mirrors this). The spread yields
`{ response, status, options, message, name }` — so **`name` (the exception class
name) is client-visible on every REST error**. A new subclass silently changes the
wire format: `name: "AccessDeniedException"` instead of `"ForbiddenException"`, and
`options` disappears when the 3rd `super()` arg is omitted. GraphQL is unaffected —
it surfaces `getResponse()` under `extensions.originalError`.

**2. `extends HttpException` is `instanceof` NEITHER `ForbiddenException` NOR
`UnauthorizedException`.**
Verified empirically. A subclass that picks its status at runtime (e.g.
`AccessDeniedException(user)` → 403/401) therefore breaks every downstream
`instanceof UnauthorizedException` / `instanceof ForbiddenException` check and every
`@Catch(ForbiddenException)` filter — including authz-denial audit logging (OWASP
A09) in consumer projects. Framework-internal catch sites that key on this:
`core-better-auth.controller.ts:456` + `:938`, `core-system-setup.service.ts:112/217`,
`core-ai-prompt.service.ts:158`.

**Why:** found on `fix/403-for-permission-errors` (PR #559, 11.28.0). The PR's own
unit spec asserted `getResponse()` body parity with the native exceptions — which
passes — so the `instanceof` divergence went undetected, and the shipped migration
guide told consumers to "match `ForbiddenException` instead", which does not work.

**How to apply:** when a diff adds or changes an exception class, always check
(a) `instanceof` against the native Nest exception it replaces, and (b) the
`{ ...exception }` spread shape, not just `getResponse()`. Prefer a factory returning
the **native** exceptions over a new `HttpException` subclass when the only goal is
picking between 401 and 403. See also [[project-betterauth-native-cookie-forwarding]]
for another "framework serializes something verbatim" trap in this repo.
