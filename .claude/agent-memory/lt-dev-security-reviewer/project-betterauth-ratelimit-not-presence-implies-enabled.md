---
name: project-betterauth-ratelimit-not-presence-implies-enabled
description: FIXED in 11.36.1 — CoreBetterAuthRateLimiter ignored "presence implies enabled" while its legacy sibling honoured it, the middleware mount was separately gated, and strictEndpoints named routes Better-Auth never serves. Do not re-report; probe below proves the fix.
metadata:
  type: project
---

**STATUS: FIXED in 11.36.1. Do not re-report.** Kept for the two-layer lesson and the probe.

## What the defect was

Two sibling limiters, opposite semantics, and the DOCUMENTED one was on the legacy side.
`.claude/rules/configurable-features.md` lists both `auth.rateLimit` and `betterAuth.rateLimit` as
"Presence Implies Enabled". Only the first one was.

| config | `betterAuth.rateLimit` (before) | `auth.rateLimit` |
|---|---|---|
| `undefined` | off | off |
| `{}` | **off** | on |
| `{ max: 20 }` | **off** | on |
| `{ enabled: true }` | on | on |

`LegacyAuthRateLimiter.configure()` computed `const enabled = config.enabled !== false`.
`CoreBetterAuthRateLimiter.configure()` just spread `{...DEFAULT_CONFIG, ...config}` over an
`enabled: false` default, and emitted no warning for the silently-inert case.

**Two layers, not one** — this is the part worth remembering. Fixing `configure()` alone was not
enough: `CoreBetterAuthModule.configure(consumer)` mounted `CoreBetterAuthRateLimitMiddleware` only
when `currentConfig?.rateLimit?.enabled` was truthy, so a config object without an explicit
`enabled: true` never got the middleware either. A fix to one layer is unobservable without the
other — the limiter would report itself enabled while nothing was mounted.

**`strictEndpoints` was partly dead config.** The default was
`['/sign-in','/sign-up','/forgot-password','/reset-password']`, matched by `===`/`endsWith`/`includes`
against the basePath-relative path. Better-Auth 1.6.x serves `/request-password-reset` and
`/forget-password` (forgET) — `/forgot-password` is a spelling it never uses. So the request half of
the reset flow got the FULL limit while only the token-submit half got the halved strict limit: the
expensive, mail-sending, amplifying half was the more loosely limited one.

## The fix

Both layers now compute `enabled: config.enabled !== false` (absent config still means off, for
backward compatibility). `strictEndpoints` gained `/request-password-reset`, `/forget-password` and
`/change-password`; `/forgot-password` is kept only for projects that route it themselves.

**Upgrade consequence worth recalling:** a project that wrote `rateLimit: { max: 20 }` believing it
was throttled was NOT, and now is. Requests that always passed can now get 429. Documented as §2 of
`migration-guides/11.36.0-to-11.36.1.md`.

## Probe (re-verify rather than reading)

```bash
node_modules/.bin/tsx -e "import {CoreBetterAuthRateLimiter} from './src/core/modules/better-auth/core-better-auth-rate-limiter.service';
const r=new CoreBetterAuthRateLimiter(); r.configure({max:20} as any); console.log(r.isEnabled())"
```

Expected NOW: `true`. `false` means `configure()` was reverted. Checking the MOUNT needs a separate
read of `CoreBetterAuthModule.configure(consumer)` — the probe cannot see that layer.

## The lesson worth keeping

When a feature's enable state is decided in more than one place, a probe that exercises only one of
them proves nothing. Ask "what else gates this?" before believing a green check.

Related: [[project-rate-limit-store-asymmetry.md]] covers the STORE layer (key caps, trusted
X-Forwarded-For) and is **not** fixed; this note is the ENABLE layer above it.
