---
name: better-auth-2fa-test-facts
description: Better-Auth 1.7.x TOTP behaviour that decides whether a 2FA story test is real or vacuous — activation needs verify-totp, the confirm swaps the session, no replay protection; plus how the 12.0.0 native-password normalization is pinned
metadata:
  type: project
---

Facts verified 2026-10-24 against better-auth 1.7.12 (`dist/plugins/two-factor/totp/index.mjs`) while
reviewing the 12.0.0 strict 2FA story rewrites (`better-auth-plugins.story.test.ts`,
`better-auth-jwt-middleware.story.test.ts`).

- **`/two-factor/enable` alone does NOT activate 2FA in TOTP mode.** Only a following
  `/two-factor/verify-totp` with a code from the new secret sets `twoFactorEnabled` + `verified`.
  Every pre-12.0.0 2FA story skipped that step, so sign-in never asked for the second factor and the
  cases returned early (`if (!requires2FA) return`) — vacuous for their whole life.
- **The confirming verify-totp deletes the caller's active session and creates a new one.** A later
  request with the old bearer still works when it is a JWT (the middleware resolves it via
  `getActiveSessionForUser`); with an opaque session token it would be 401. Read that before calling a
  follow-up 401 a product bug.
- **No replay protection:** the same TOTP code is accepted twice inside one 30 s period, and
  `createOTP().verify` tolerates a window of 1, so `totp.generate()` twice in one test is not a flake.
- Rate limit in `e2e` is 100/60 s (strict endpoints halved); the plugins story makes ~54 IAM requests,
  well clear of it.

**Native password normalization (12.0.0, `PASSWORD_FIELD_PATHS`):** pinned by two mutations — the
per-route logic by `native-password-routes-not-normalized` (unit, 3 cases red) and the WIRING in
`use()` by `native-password-normalization-unwired` (plugins story; 3 cases red there, and the
jwt-middleware 2FA case goes red too). `/change-password` got an e2e of its own the same day: "5. Plugin Error Handling" pins the
length refusal as an HTTP 400 (was a 500 from the middleware catch), mutation
`native-password-length-refusal-answered-500`.

**How to apply:** in a 2FA test review, check for the verify-totp activation step and for a guard
(`if (!token) return`) that could make the case skip; prove red under the unwired mutation in a
scratch copy ([[scratch-copy-mutation-check]]).
