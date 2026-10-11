---
name: secure-cookie-auth-link-gating
description: 11.42.12 Secure-cookie (secureTransport / https baseUrl) and auth-link log (isLocalEnv allowlist) changes — verified facts so they are not re-derived or re-flagged
metadata:
  type: project
---

11.42.12 (reviewed 2026-10-11, zero findings): auth cookies take `Secure` from the transport, not only
from the env name; the reset/verification link log is printed only in `local`/`ci`/`e2e` (`isLocalEnv()`,
reads `LOCALHOST_URL_ENVS`), opt-in `LT_LOG_AUTH_URLS=1`, never in production-like envs.

Verified facts:
- `CoreBetterAuthService.usesSecureCookies()` reads `instance.options.advanced`. better-auth 1.7.7
  `createBetterAuth()` returns the INPUT `options` object verbatim, i.e. `finalConfig` from
  `createBetterAuthInstance()` including the deep-merged `defaultCookieAttributes` — the right source.
  No built-in plugin `init()` touches cookie attributes.
- The instance is constructor-injected into the service via a factory on `BETTER_AUTH_INSTANCE`, so the
  controller's constructor-time `usesSecureCookies?.()` sees it.
- `Secure` is never removed by this change: both helpers OR the new signal onto the old env rule.
- `cookies.helper.ts` has only type imports → `outbound-url.helper → cookies.helper` adds no cycle.
- Consumers that parse `[EMAIL VERIFICATION] … token=` from API stdout (lt-monorepo CI) run
  `start:e2e:dist` with `NODE_ENV=e2e`; `lt dev up` / `lt dev test` run the API with `NODE_ENV=local`.
  Both still print.

**Why:** these took real tracing (better-auth dist, CLI, monorepo CI) to establish.
**How to apply:** on a follow-up touching these paths, start from these facts; re-check only if
better-auth's `createBetterAuth` return shape or the CLI's NODE_ENV changes. Related: [[core-controller-override-contract]].
