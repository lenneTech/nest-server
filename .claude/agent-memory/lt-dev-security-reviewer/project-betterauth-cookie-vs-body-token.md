---
name: project-betterauth-cookie-vs-body-token
description: cookie=opaque token vs body=JWT under exposeTokenInBody — FIXED in 11.36.3 by a structural refusal in setSessionCookies(); records why isJwtShaped() is sound and where the guard is still silent
metadata:
  type: project
---

With `cookies: { exposeTokenInBody: true }` the two delivery channels carry DIFFERENT values: the
`<prefix>.session_token` cookie must get the **opaque** better-auth session token, the response body
gets the **JWT** from `resolveJwtToken()`. Writing the JWT into the cookie fails CLOSED — the symptom
is `/iam/session` → `success: false` for a session that exists in the DB.

**FIXED in 11.36.3. Do not re-report the defect itself.** Three layers now:
`CoreBetterAuthController.sessionTokenForCookie()` derives the cookie value, the sign-in/sign-up call
sites pass it to `processCookies()`, and `BetterAuthCookieHelper.setSessionCookies()` **structurally
refuses** any JWT-shaped value regardless of call site.

**Scope of the original defect — confirmed dev-only, the advisory is accurate.**
`shouldConvertSessionTokenToJwt()` returns `false` in cookies-only mode
(`cookiesEnabled && !exposeTokenInBody`), so production never converted the token in the first place;
and `assertCookiesProductionSafe()` IS wired, at `core.module.ts:195`.

**`isJwtShaped()` is sound — verified, do not re-litigate.** better-auth builds ids with
`createRandomStringGenerator("a-z","0-9","A-Z","-_")`
(`node_modules/better-auth/dist/crypto/random.mjs:3`), so an opaque token **cannot contain a dot**;
requiring `split('.').length === 3` gives ZERO false positives. Confirmed empirically that an
`eyJ`-prefixed opaque token is still accepted. better-auth's own signed-cookie format
(`value.signature`, 2 parts) would also break on a dot, so the property is enforced upstream too.
`setSessionCookiesFromWebResponse` (2FA/passkey/social) is unaffected: it matches only
`${cookieName}=` and strips the 2-part signature, so it always yields the opaque value.

**Where it is still silent:** `setSessionCookies()` logs the refusal via `this.config.logger?.error`
— OPTIONAL. Both in-repo call sites pass a logger, but `BetterAuthCookieHelper` is exported public
API, and a consumer constructing it directly (as the repo's own unit tests do) gets a fully silent
refusal: zero cookies written, no log, HTTP 200 `success: true`. Verified directly.

**Evidence now exists at both levels** (it did not before — the old story passed with the defect
restored): mutation `session-cookie-must-not-carry-body-jwt` (helper +
`tests/unit/better-auth-cookie-helper.spec.ts`) and `signin-cookie-drops-session-token` (controller
call site + `tests/stories/cookies-security-property.e2e-spec.ts`). Neither substitutes for the other:
`processCookies()` returns early once a session token is present, so the helper's unit tests are
unreachable from the repaired path. Verified the helper mutation goes red (2 of 22).

**Caveat worth re-checking if these tests change:** because `setSessionCookies()` now REFUSES, the
helper mutation produces "no cookie at all", not "a JWT in the cookie". Any assertion shaped as
`for (const c of calls) expect(...)` therefore passes VACUOUSLY under it unless guarded by
`expect(calls.length).toBeGreaterThan(0)`.

Related: [[project-betterauth-native-cookie-forwarding]], [[project-e2e-node-env-trap]],
[[project-check-mutations-tooling-risks]]
