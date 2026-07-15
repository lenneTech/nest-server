---
name: project-betterauth-native-cookie-forwarding
description: BetterAuth's two cookie-writing paths (helper vs native-forward) and why the "useSecureCookies:false strips Secure" finding (SEC-001) is FIXED — do not re-report it
metadata:
  type: project
---

BetterAuth session cookies in nest-server are written by TWO distinct paths. This split is durable
architecture and worth knowing — but the security finding once attached to it (SEC-001) is **RESOLVED**.

## The two paths (verified, still true)

- **Helper path** — `BetterAuthCookieHelper.setSessionCookies()` (`core-better-auth-cookie.helper.ts`),
  reached via `processCookies` in `core-better-auth.controller.ts`. Serves only
  `CONTROLLER_HANDLED_PATHS` = `/features`, `/sign-in/email`, `/sign-up/email`, `/sign-out`, `/session`
  (`core-better-auth-api.middleware.ts:24`).
- **Native-forward path** — everything else: 2FA verify, social callback, magic link, passkey, `/token`.
  `authInstance.handler()` → `sendWebResponse()` (`core-better-auth-web.helper.ts:217-221`) forwards
  `getSetCookie()` **verbatim** — it never re-secures. So BetterAuth's own cookie attributes ARE the wire bytes.

## SEC-001 is FIXED — do NOT re-report it

**Claim (false as of 11.27.6+):** "pinning `advanced.useSecureCookies: false` strips `Secure` from
native-forwarded session cookies over https."

**Why it is false:** in BetterAuth's `createCookieGetter()` (`node_modules/better-auth/dist/cookies/index.mjs`),
`secure: !!secureCookiePrefix` (line **32**) is only a DEFAULT inside an object literal, and
`...options.advanced?.defaultCookieAttributes` (line **37**) is spread **after** it in the SAME literal — so it
WINS. The cookie NAME (line 30) is derived from `secureCookiePrefix` independently. Name and Secure-attribute are
therefore **decoupled**, which is exactly what lets `better-auth.config.ts:420` inject
`...(secureCookies && { defaultCookieAttributes: { secure: true } })` on an `https://` baseURL: unprefixed NAME
(fixes the 401 split-brain) + `Secure` TRANSPORT flag (preserves confidentiality).

Runtime-proven `Set-Cookie` from `auth.handler()` (https baseURL, production):
`iam.session_token=…; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax`

Regression tests: `tests/unit/better-auth-secure-cookies.spec.ts` — incl. a test literally named
`(SEC-001)`, plus library-guard tests that call BetterAuth's own `getCookies()` to pin the spread-order
dependency.

**Why the stale finding existed:** SEC-001 was real against an INTERMEDIATE state of commit 83b59e1 (only the
pin, no `defaultCookieAttributes`). The fix was folded into the SAME commit before it landed. The review was
never re-verified, so an already-remediated finding survived in memory as if open.

## Real residual footgun (LOW, still open)

`better-auth.config.ts:476-479` shallow-merges a consumer's `options.advanced` over the framework's, so a project
setting `advanced.defaultCookieAttributes` for ANY reason (e.g. `{ partitioned: true }`) **wholesale-replaces**
the framework's `{ secure: true }` → `secure:false` on https. Runtime-confirmed. Deep-merging that one key
(`defaultCookieAttributes: { secure: true, ...consumer }`) would close it.

**How to apply:** when reviewing BetterAuth cookie/`Secure`/`SameSite` changes, still check BOTH paths — but
verify against `createCookieGetter`'s FULL object literal (through line 39), not just the `secure:` line. Before
re-reporting ANY finding carried in memory, re-verify against current code: this one was fixed in the same
commit that introduced it. Related: [[project-betterauth-di-failclosed-and-cycle-triage]].
