---
name: better-auth-request-url-and-base-url-readers
description: Who actually reads the host of the in-process Web Requests the framework hands Better-Auth, and that consumer code calls getBaseUrl() for real network self-fetches — the shortcut for judging "is a changed base URL consumer-visible"
metadata:
  type: project
---

When a diff changes what `CoreBetterAuthService.getBaseUrl()` returns (11.43.1: it now returns the
ORIGIN of the instance's `options.baseURL` instead of `betterAuth.baseUrl` only), two different audiences see it.

**1. Better-Auth itself, through the Web Requests the framework builds** (`toWebRequest()`, the 2FA
forward in `CoreBetterAuthController.signIn`, `csrfCheckedRequest()`). These go to
`authInstance.handler()` in-process — the host is never dialled. In better-auth 1.7.7 the request
URL's ORIGIN is read only by:
- `utils/url.mjs` `getBaseURL()` — only when no `baseURL` is configured (never the case here, the
  framework always passes one);
- the `oauth-proxy` plugin (`checkSkipProxy` / `resolveCurrentURL`) — not a nest-server built-in;
- `origin-check.mjs` reads only the PATHNAME.
The 2FA forward also uses `getBaseUrl()` as the `Origin` fallback; Better-Auth always trusts its own
baseURL origin, so the instance value can only widen what succeeds, never narrow it.

**2. Consumer code.** At least one vendor-mode consumer calls `betterAuthService.getBaseUrl()` to
build URLs for real `fetch()` calls back into its own API (magic-link invite, passkey helpers). A
changed return value moves that traffic from `http://localhost:3000` (in-container) to the public
URL. That consumer sets `NSC__BETTER_AUTH__BASE_URL`, so it was unaffected in 11.43.1 — but check
again whenever this method's resolution changes.

**Why:** Settled the "does the changed URL origin need a migration note" question in the 11.43.1
review (2026-10-20) without running anything. **How to apply:** for any base-URL change in the
better-auth module, re-grep `node_modules/better-auth/dist` for `request.url` (the reader list can
grow with a better-auth upgrade) and grep vendor consumers' `src/server` for `.getBaseUrl()`.
Related: [[vendor-local-patch-collision-check]], [[trusted-origins-replace-semantics]].
