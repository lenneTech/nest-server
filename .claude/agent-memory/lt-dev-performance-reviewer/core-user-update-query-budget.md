---
name: core-user-update-query-budget
description: Per-call DB budget of CoreUserService.update() incl. the IAM email/name/password syncs, and which internal callers (login, token refresh, logout) can or cannot trigger them — re-check before flagging a new sync as a hot-path cost.
metadata:
  type: project
---

`CoreUserService.update()` (src/core/modules/user/core-user.service.ts) costs, as of DEV-3821 (2026-10-27):
1 lean `findById` (oldUser) + the full `super.update()` process() pipeline, then per sync branch:
email change → `syncEmailChangeFromLegacy`; firstName/lastName in input → 1 projected lean `findById`
+ 1 native `updateOne({ email })` (email has `index: true` on CoreUserModel, so no COLLSCAN);
password → scrypt + account write.

**Why it is not a hot path:** the only internal callers in `src/core` are `CoreAuthService`
(`updateRefreshToken`, logout) and they pass ONLY `refreshTokens` / `tempTokens` — never names, email
or password. So login and token refresh never fire the sync branches. Name/email syncs run only on
user-initiated PATCH /users/:id, the updateUser mutation, or a project's own call.
`CrudService.findAndUpdate()` is the one fan-out (N x update()), pre-existing.

**How to apply:** when a review adds another sync branch to update(), first grep
`userService.update(` / `this.update(` for internal callers that pass the triggering field; only
those make it a per-login cost. `CoreBetterAuthUserMapper.linkOrCreateUser()` (IAM sign-in) already
does one full `findOne` + one `findOneAndUpdate` per sign-in; in-memory comparisons against
`existingUser` add nothing.

Related: [[auth-gate-per-request-cost]], [[better-auth-jwt-verify-costs]].
