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

## Role Check Implementation

The role system is evaluated in:
- `RolesGuard` - Checks method-level `@Roles()` decorators
- `CheckResponseInterceptor` - Filters fields based on `@Restricted()` decorators
- `CheckSecurityInterceptor` - Processes `securityCheck()` methods

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
