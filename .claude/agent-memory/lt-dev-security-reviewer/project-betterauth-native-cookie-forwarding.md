---
name: project-betterauth-native-cookie-forwarding
description: BetterAuth native-handler paths forward Set-Cookie verbatim and bypass BetterAuthCookieHelper's Secure flag; useSecureCookies:false drops Secure on those session paths
metadata:
  type: project
---

BetterAuth session cookies in nest-server are written by TWO distinct paths with different transport-security guarantees. This split is durable architecture, not a one-off.

- **Helper path** — `BetterAuthCookieHelper.setSessionCookies()` (`core-better-auth-cookie.helper.ts`) sets `secure: isProductionLikeEnv(env)`. Used by the email/password sign-in success path (`processCookies`) and the passkey middleware re-set (`setSessionCookiesFromWebResponse`, `core-better-auth-api.middleware.ts:288`). These get `Secure` in prod.
- **Native-forward path** — `handleBetterAuthPlugins` catch-all (`core-better-auth.controller.ts:897`) and the middleware fallbacks call `authInstance.handler()` then `sendWebResponse()` (`core-better-auth-web.helper.ts:208`), which forwards BetterAuth's `Set-Cookie` **verbatim** (merges, never re-secures). This path serves **2FA verify, social login callback, magic link** (all session-ESTABLISHING) and the READ handlers (2FA enable/disable, passkey register/list, `/token`).

The reader (`resolveBetterAuthSessionCookieName`, `better-auth-cookie-prefix.helper.ts:57`) only ever resolves the UNPREFIXED `<prefix>.session_token` — it is NOT `__Secure-`-aware. BetterAuth's own reader IS (`node_modules/better-auth/dist/cookies/index.mjs:212` reads `__Secure-<name> ?? <name>`).

**Why:** In 11.27.6 this name mismatch was "fixed" by pinning `advanced.useSecureCookies: false` in `better-auth.config.ts`. In BetterAuth's `createCookieGetter` (cookies/index.mjs:21-32) `secure: !!secureCookiePrefix`, so `useSecureCookies:false` sets `secure:false` AND unprefixes — it does NOT merely rename. Result: native-forwarded session cookies ship WITHOUT `Secure` over https in production. The email/password path is unaffected (helper still sets Secure), which is why the code comment / migration guide claimed "confidentiality unaffected" / "Security Updates: None" — accurate only for the helper path.

**How to apply:** When reviewing any BetterAuth cookie/`Secure`/`SameSite` change, check BOTH paths. A change that looks helper-only (which sets Secure correctly) can still leave native-forwarded session-establishment (2FA/social/magic-link/passkey) insecure. The robust fix is making the reader/writer `__Secure-`-aware in prod (mirror BetterAuth's dual-read) rather than disabling `useSecureCookies` globally. Related: [[project-ai-module-secret-stripping]].
