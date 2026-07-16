---
name: project-betterauth-input-false-enforcement
description: How Better-Auth `input:false` on user additionalFields is enforced (single chokepoint parseInputData, keyed on object-key not fieldName) + the roles/verified privesc fix completeness
metadata:
  type: project
---

Better-Auth `input: false` on `user.additionalFields` (roles/verified/verifiedAt/twoFactorEnabled/iamId privilege-escalation fix in `better-auth.config.ts` `buildUserFields` + `PROTECTED_INPUT_FALSE_KEYS` re-assertion loop).

**Why:** confirmed vertical privesc — any authed user could `POST /iam/update-user {"roles":["admin"]}` (raw-forwarded to BA native handler under sessionMiddleware, bypassing controller `@Roles(ADMIN)` + `checkRoles`). Fix marks server-managed fields `input:false`.

**How to apply — the enforcement is a SINGLE chokepoint** (`node_modules/better-auth/dist/db/schema.mjs` `parseInputData`, BA 1.6.23), so covering it covers ALL native user-write routes at once:
- `parseUserInput(create)` = sign-up: `input:false` + defaultValue → SILENTLY substitutes default (no 400). So sign-up privesc is blocked but returns 201, not FIELD_NOT_ALLOWED.
- `parseUserInput(update)` = update-user: `input:false` → throws FIELD_NOT_ALLOWED (400).
- `parseAdditionalUserInputFromProviderProfile` = social/OAuth link: explicitly `if (schema[key]?.input===false) continue` BEFORE parse — stronger, filtered out.
- `getFields(user,'input')` returns ONLY additionalFields (coreSchema is `{}` for input mode). So BA core fields (email/emailVerified/password) are NOT settable via update-user regardless: `email` throws EMAIL_CAN_NOT_BE_UPDATED, the rest are silently dropped (not keys in the input schema). additionalFields were the ONLY privesc vector.
- Controller-handled `/sign-up/email` (in CONTROLLER_HANDLED_PATHS) is triple-safe: DTO `CoreBetterAuthSignUpInput` has no roles, handler passes only `{email,name,password}` to `api.signUpEmail`, and BA would substitute defaults anyway.

**Residual completeness gaps (both project-config-only, LOW/INFO — external attacker cannot trigger):**
1. **Shadow-key gap:** both `parseInputData` and the re-assertion loop key on the object-KEY, not `fieldName`/column. A project declaring `additionalUserFields: { anyKey: { fieldName: 'roles', input: true } }` escapes the hard-lock. Hardening: also reject any non-protected field whose `fieldName` collides with a protected column.
2. **admin plugin:** default plugins are jwt/twoFactor/passkey only. If a project adds BA's admin plugin, it introduces singular `role`/`banned`/`banReason`/`banExpires` NOT in `PROTECTED_INPUT_FALSE_KEYS`. nest-server authz uses `roles` (array), so singular `role` is orthogonal; admin endpoints are admin-gated by the plugin.

**nest-server's own role path is disjoint and unaffected:** `UserService.setRoles` / `CrudService.update` / user-mapper `linkOrCreateUser`/`mapSessionUser` write via native Mongoose `$set`, never `api.updateUser`. The one regression class to check on any future change: a sync path that writes a protected field THROUGH `api.updateUser` would now 400.

Rejection is HTTP 400 (BAD_REQUEST) — does NOT touch the 401/403 auto-logout policy or `securityCheck` (input-parse stage, pre-persistence).
