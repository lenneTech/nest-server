# Role System (RoleEnum)

The role system distinguishes between **real roles** and **system roles**.

## Real Roles

Actual roles stored in `user.roles` array in the database:

- `RoleEnum.ADMIN` - Administrator role

## System Roles (S_ Prefix)

System roles are used for **runtime checks only** and must **NEVER** be stored in `user.roles`:

| Role | Purpose | Check Logic |
|------|---------|-------------|
| `S_USER` | User is logged in | `currentUser` exists |
| `S_VERIFIED` | User is verified | `user.verified \|\| user.verifiedAt \|\| user.emailVerified` |
| `S_CREATOR` | User created the object | `object.createdBy === user.id` |
| `S_SELF` | User is accessing own data | `object.id === user.id` |
| `S_EVERYONE` | Public access | Always true |
| `S_NO_ONE` | Locked access | Always false |

### `object` means the PERSISTED object — never the request payload

For `S_SELF` and `S_CREATOR`, "object" is the record loaded from the database
(`serviceOptions.dbObject`), **not** the input DTO. This distinction is security-critical.

On the **input** path the DTO is fully attacker-controlled. Deciding `S_SELF` from it would let an
authenticated attacker unlock an owner-restricted field on someone else's record just by putting
their own id in the body — the service writes to the target it was called with, not to the id in the
payload:

```
PATCH /users/<victim-id>   { "id": "<attacker-id>", "iban": "DE...attacker" }
```

On the **output** path there is no attacker-controlled input: the object being checked *is* the
persisted record (and a list is checked per item), so it is the correct comparison target there.

Both `check()` (`input.helper.ts`) and `checkRestricted()` (`restricted.decorator.ts`) implement this.
If you write your own rights check, compare against `dbObject` on input — never against the DTO.

### ⚠️ `S_CREATOR` is the CREATOR of the record — which is often an admin, not the user

`createdBy` is set by the audit plugin to whoever **created the record**. On a self-signup that is the
user themselves. But in an **invite or admin-provisioning flow it is the inviting admin** — and it
stays that way forever.

So `@Restricted(S_CREATOR)` on a **User input field** does not mean "the user may edit their own
field". It means **"whoever created this account may edit it"** — granting the inviter permanent
write access to the invited user's record.

That is almost never the intent, and it is dangerous on exactly the fields people reach for it on:

```typescript
// DANGEROUS on an invite-based system: the inviting workspace admin IS the creator, so this
// lets them rewrite the invited member's email — and then trigger a password reset.
@UnifiedField({ roles: [RoleEnum.ADMIN, RoleEnum.S_CREATOR] })
email?: string;

// SAFE: only a system admin, and the user changes their own email through the verification-gated
// BetterAuth changeEmail flow, never through a generic update DTO.
@UnifiedField({ roles: [RoleEnum.ADMIN] })
email?: string;
```

**Upgrade note:** before v11.28.x, `S_SELF`/`S_CREATOR` on an *input* field never actually fired —
the check read the claim off the DTO, and `MapAndValidatePipe` strips `id`/`createdBy` from payloads
(they are not `@UnifiedField`s). Such fields were therefore effectively **admin-only-or-denied**.
Now that the check reads the persisted object, they start working — and a field that looked
owner-restricted may suddenly become writable by an admin who provisioned the record. **Audit every
`S_SELF`/`S_CREATOR` on an input type before upgrading.**

## Critical Rule

```typescript
// CORRECT: Using S_ roles in decorators (runtime checks)
@Roles(RoleEnum.S_USER)
@Restricted(RoleEnum.S_VERIFIED)

// WRONG: Storing S_ roles in user.roles array
roles: [RoleEnum.S_USER]  // NEVER do this!

// CORRECT: Empty roles or real roles only
roles: []                  // Empty array
roles: [RoleEnum.ADMIN]    // Real role
```

The `S_` prefix indicates a **system check**, not an actual role. These are evaluated dynamically at runtime based on context (current user, request, object being accessed).

## Role Decorators

- `@Roles(RoleEnum.ADMIN)` - Method-level authorization
- `@Restricted(RoleEnum.S_VERIFIED)` - Field-level access control

## Hierarchy Roles (Multi-Tenancy)

When `multiTenancy` is configured, hierarchy roles replace the old `S_TENANT_*` system roles:

```typescript
import { DefaultHR, createHierarchyRoles } from '@lenne.tech/nest-server';

// Default hierarchy
@Roles(DefaultHR.MEMBER)   // any active member (level >= 1)
@Roles(DefaultHR.MANAGER)  // at least manager level (level >= 2)
@Roles(DefaultHR.OWNER)    // highest level (level >= 3)

// Custom hierarchy
const HR = createHierarchyRoles({ viewer: 1, editor: 2, admin: 3, owner: 4 });
@Roles(HR.EDITOR)           // requires level >= 2

// Normal (non-hierarchy) roles
@Roles('auditor')           // exact match only, no level compensation
```

**System role OR semantics in CoreTenantGuard:** System roles (`S_EVERYONE`, `S_USER`, `S_VERIFIED`) are checked as OR alternatives **before** real roles. Method-level system roles take precedence over class-level ones (e.g., class `S_EVERYONE` + method `S_USER` → `S_USER` applies). When a system role grants access and `X-Tenant-Id` header is present, membership is still validated to set tenant context — a non-member gets 403 with `S_USER`/`S_VERIFIED` (admin bypass applies).

**Tenant context rule for real roles:** When `X-Tenant-Id` header is present, only `membership.role` is checked. `user.roles` is ignored (except ADMIN bypass). Without header, `user.roles` is checked.

Hierarchy roles use **level comparison** (higher includes lower). Normal roles use **exact match**.

Both work in `@Roles()` (method-level) and `@Restricted()` (field-level) via unified `checkRoleAccess()`.

## Role Check Implementation

The role system is evaluated in:
- `RolesGuard` / `BetterAuthRolesGuard` - Checks method-level `@Roles()` decorators (passes through non-system roles to `CoreTenantGuard` when multiTenancy active)
- `CoreTenantGuard` - Validates tenant membership and checks hierarchy/normal roles
- `CheckResponseInterceptor` - Filters fields based on `@Restricted()` decorators
- `CheckSecurityInterceptor` - Processes `securityCheck()` methods

## Status Codes: 401 vs 403 (v11.28.0+)

**All five permission layers answer with the same policy.** Getting this wrong has a concrete
consequence: SPA auth layers treat 401 as "session expired" and log the user out — so a mere
permission error returned as 401 kicks a logged-in user out of the whole app.

| Situation | Status | Message |
|-----------|--------|---------|
| Requester is **not authenticated** | **401** | `ErrorCode.UNAUTHORIZED` |
| Requester **is authenticated** but lacks a right | **403** | `ErrorCode.ACCESS_DENIED` |
| `S_NO_ONE` (locked for everyone) | **403 always**, even for anonymous requesters | `ErrorCode.ACCESS_DENIED` |

`S_NO_ONE` is 403 even without a session because authenticating can *never* unlock it — a 401 would
tell the client to log in and retry, which is a lie.

Exception: `ErrorCode.EMAIL_VERIFICATION_REQUIRED` is a legitimate **401** (thrown at sign-in, where
no session exists yet). Frontends must branch on the ErrorCode, not on the status alone, so this one
does not trigger the logout flow.

### Never hand-roll the decision

```typescript
import { accessDeniedException } from '@lenne.tech/nest-server';

// CORRECT — one policy, native exceptions (instanceof / @Catch keep working)
throw accessDeniedException(currentUser);
throw accessDeniedException(currentUser, 'Custom message');

// WRONG — drifts from the framework policy and mishandles falsy-but-present ids (0, '')
throw currentUser?.id ? new ForbiddenException() : new UnauthorizedException();

// WRONG — a permission error must never be a 401 for an authenticated user
throw new UnauthorizedException('Missing rights');
```

**This applies to `securityCheck()` in your models too.** `CoreTenantMemberModel` is the reference
implementation. A model that throws `UnauthorizedException` from `securityCheck()` reintroduces the
auto-logout bug in your own project.

## @Roles vs @UseGuards

**IMPORTANT: `@Roles()` already handles JWT authentication internally.**

```typescript
// CORRECT: @Roles alone is sufficient for authentication + authorization
@Query(() => SomeModel)
@Roles(RoleEnum.ADMIN)
async someAdminQuery(): Promise<SomeModel> { }

// WRONG: Don't add @UseGuards when @Roles is present
@Query(() => SomeModel)
@Roles(RoleEnum.ADMIN)
@UseGuards(AuthGuard(AuthGuardStrategy.JWT))  // REDUNDANT - Roles already handles this
async someAdminQuery(): Promise<SomeModel> { }
```

The `@Roles()` decorator combined with `RolesGuard` automatically:
1. Validates the JWT token
2. Extracts the user from the token
3. Checks if the user has the required role

### When @UseGuards IS Required

`@UseGuards(AuthGuard(...))` is only needed in these specific cases:

| Case | Example | Reason |
|------|---------|--------|
| **Refresh Token** | `@UseGuards(AuthGuard(AuthGuardStrategy.JWT_REFRESH))` | Different strategy than standard JWT |
| **Custom Strategies** | `@UseGuards(AuthGuard(AuthGuardStrategy.CUSTOM))` | Non-standard authentication flow |

```typescript
// CORRECT: refreshToken needs JWT_REFRESH strategy (not standard JWT)
@Mutation(() => CoreAuthModel)
@Roles(RoleEnum.S_EVERYONE)
@UseGuards(AuthGuard(AuthGuardStrategy.JWT_REFRESH))  // Required - different strategy!
async refreshToken(...): Promise<CoreAuthModel> { }

// CORRECT: Standard endpoints - @Roles is sufficient
@Mutation(() => CoreAuthModel)
@Roles(RoleEnum.S_USER)  // Handles JWT auth automatically
async logout(...): Promise<boolean> { }

@Query(() => User)
@Roles(RoleEnum.ADMIN)  // Handles JWT auth automatically
async getUser(...): Promise<User> { }
```

### Common Mistake: Redundant Guards

When reviewing code, watch for this anti-pattern:

```typescript
// WRONG: Redundant - @Roles(S_USER) already validates JWT
@Roles(RoleEnum.S_USER)
@UseGuards(AuthGuard(AuthGuardStrategy.JWT))  // DELETE THIS
async someMethod() { }

// WRONG: Redundant - @Roles(ADMIN) already validates JWT
@Roles(RoleEnum.ADMIN)
@UseGuards(AuthGuard(AuthGuardStrategy.JWT))  // DELETE THIS
async adminMethod() { }
```

**Rule of thumb:** If `@Roles()` uses any role OTHER than `S_EVERYONE`, you don't need `@UseGuards(AuthGuard(JWT))`.
