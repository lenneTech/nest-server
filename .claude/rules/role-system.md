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

### Since 11.35.0 this is ENFORCED, not just a convention

`hasRole()` is a plain string intersection, so a stored `'s_self'` satisfies **every** `S_SELF`
check — for the core user module that includes `updateUser` / `deleteUser` on *arbitrary* users
(mail/password change → account takeover) — while the account shows no privileged role at all.
The rule was documented for years and nothing enforced it. Three layers now do:

| Layer | Covers | On violation | Configurable |
|-------|--------|--------------|--------------|
| `CoreUserInput.roles` validator | the input/DTO path (REST + GraphQL, create + update) | 400 | no, but a subclass override **replaces** it (see below) |
| `CoreUserService.setRoles()` | the canonical role-assignment API (writes via `findByIdAndUpdate`) | throws, before the DB round-trip | no |
| `mongooseSystemRolePlugin` | **every** Mongoose write — incl. `force: true`, `runWithBypassRoleGuard()`, direct `Model` calls, seeds, migrations | throws | **no** |

Do not confuse the third with `mongooseRoleGuardPlugin`: that one answers *who may change roles*
(configurable, bypassable, **strips** the change); this one answers *which values may exist at all*
(unconditional, **throws**). Being ADMIN or holding a bypass is authority over the change, never
permission to write a value that is invalid by construction.

**The plugin refuses what a write INTRODUCES, not what is already stored** — load-bearing, not
leniency. `CrudService.update()` writes the whole object back, so a login
(`updateRefreshToken` → `update`) re-sends the stored `roles` verbatim; refusing that would lock
every already-contaminated account out on upgrade, and do the same fleet-wide to a project whose
own role name starts with `s_`. Adding a system role is refused, writing back an identical stored
value is allowed, and removing one always works. `updateMany` is the exception — it can span
documents with different baselines, so any system role in its payload is refused outright.

**The check is a prefix rule, not an allowlist of the six members above.** Any value starting with
`s_` after trimming, case-insensitively, is refused — including a project role you named
`s_manager`. The framework cannot tell those apart from a future system role, and a false
rejection is fixable by renaming while a false acceptance is a silent authorization hole.

Use the shared predicates rather than re-implementing the rule:

```typescript
import { isSystemRole, looksLikeSystemRole, SYSTEM_ROLE_PREFIX, SYSTEM_ROLE_REJECT_PATTERN }
  from '@lenne.tech/nest-server';

isSystemRole('S_SELF')        // false — exact + case-sensitive: the RUNTIME rule the guards use
looksLikeSystemRole('S_SELF') // true  — trimmed + case-insensitive: the STORAGE rule
```

They differ on purpose. The guards compare role strings exactly, so `'S_SELF'` never granted
anything and must not be treated as a system role by them; the storage question deserves the
stricter answer, because `' s_self'` and `'S_SELF'` pass an eyeball review and become live the
moment anything normalizes roles.

**Upgrade note (11.35.0):** a write carrying an `s_*` role that previously succeeded now fails —
400 on the user endpoints, a thrown exception from `setRoles()` and from any Mongoose write. Audit
once with `db.users.find({ roles: /^\s*s_/i })` before upgrading; rename your own `s_`-prefixed
roles, and remove genuine misconfigurations. Also check every project input that **redeclares**
`roles`: `MapAndValidatePipe` walks the prototype chain child-first and skips a property once a
child class has validated it, so an override silently replaces the inherited validator (the plugin
still backstops the write). See `migration-guides/11.34.x-to-11.35.x.md` §2.

## The tenant boundary: membership roles never confer global authority (11.35.0)

Roles arrive from three sources with very different trust levels, and at runtime all three are
plain strings — `RoleEnum.ADMIN` **is** `'admin'`. TypeScript enums exist only at compile time, so
they provide no protection here. The danger is a shared namespace compared with `===`:

| Source | Example | Assigned by |
|--------|---------|-------------|
| Framework role | `admin` | the platform |
| System role | `s_self` | nobody — these are runtime questions, not roles |
| Tenant membership role | `tenantAdmin` | the **customer**, as free text (`addMember` takes any non-empty string) |

Two escalation paths existed until 11.35.0, both of them reachable by whoever may manage
members — typically a tenant owner, i.e. a customer:

- A membership role literally named `'admin'` satisfied `@Roles(RoleEnum.ADMIN)` in tenant context,
  because the header path compared required roles against `membership.role` by exact string. That
  is **platform** authority granted by a **customer**.
- A membership role literally named `'s_self'` satisfied field-level `@Restricted(S_SELF)` on
  ARBITRARY records — ownership was never compared. `CoreTenantGuard` already filtered system roles
  at its own call site; `checkRestricted` did not.

### The rule: the SOURCE decides, not the spelling

Each required role is resolved against the source that is entitled to answer it
(`resolveGlobalAndTenantRoles`, OR semantics across the two halves):

| Required | Resolved against |
|----------|------------------|
| `RoleEnum.ADMIN` (and every `GLOBAL_ONLY_ROLES` member) | `user.roles` — **never** `membership.role` |
| a tenant/project role (`tenantAdmin`, `auditor`, …) | `membership.role` in tenant context, `user.roles` otherwise |
| a system role (`S_SELF`, `S_CREATOR`, …) | its dedicated check (ownership, verification, session) — never a string comparison |

This is what makes the fix durable: it depends on no name list, so an already-stored membership
named `admin` is inert rather than dangerous — no data migration needed.

The intended model is unchanged and still works:

```typescript
// Global admin — access to EVERY tenant
user.roles = [RoleEnum.ADMIN]

// Per-tenant admin — one tenant only; name it whatever the project likes, just not 'admin'
await tenantService.addMember(tenantId, userId, 'tenantAdmin');
@Roles('tenantAdmin')
```

### Second layer: reserved names are refused at assignment time

`addMember()` / `updateMemberRole()` throw on a system role (`s_*`) or a global-only role, matched
case-insensitively and trimmed (`isForbiddenMembershipRole`). This is **hygiene, not the
protection** — and the distinction matters: if a future `RoleEnum.SUPPORT` were added, every
pre-existing membership named `support` would become a hole retroactively, and no assignment-time
check can reach data that already exists. Only the source-based resolution above covers that.

### Adding a new framework role

`tests/unit/role-classification-invariants.spec.ts` fails unless every `RoleEnum` member is either
a system role (`s_` prefix) or listed in `GLOBAL_ONLY_ROLES`. Adding a role without making that
decision is exactly how the retroactive hole above gets created, so the test forces it at the
moment the role is declared.

### Declaring YOUR OWN global roles

The framework only knows its own vocabulary, so a project that guards a platform-wide endpoint with
`@Roles('auditor')` must say so — otherwise `auditor` is treated as an ordinary role and, in tenant
context, answered from `membership.role`:

```typescript
multiTenancy: {
  roleHierarchy:   { member: 1, tenantAdmin: 2, owner: 3 },  // per tenant
  globalOnlyRoles: ['auditor', 'support'],                    // platform-wide, user.roles only
}
```

The scope is stored as an **attribute**, not encoded in the role name. That is what keeps the design
open for admin-managed roles held in the database later: a `RoleScopeSource` reading from Mongo can
be registered alongside the config source, and every guard keeps working unchanged. Encoding the
scope in the string instead (`t:owner`) would put it in a value whoever creates the role can
mistype, and would add a normalization step inside the authorization path — the last place that
should grow moving parts.

| Registry answer | Meaning | Resolved against |
|-----------------|---------|------------------|
| `RoleScope.GLOBAL` | platform authority | `user.roles` |
| `RoleScope.TENANT` | authority within one tenant | `membership.role` |
| `RoleScope.SYSTEM` | runtime-context check | its dedicated check |
| `RoleScope.UNKNOWN` | declared nowhere | `user.roles`; **never** a membership role under `strictMembershipRoles` |

### Boot-time coherence check

`CoreTenantModule.forRoot()` calls `assertRoleVocabularyIsCoherent()` and **fails the boot** on:

1. a tenant role named after a framework role (`roleHierarchy: { admin: 3 }`),
2. a role declared in `globalOnlyRoles` *and* as a tenant role — it would need two sources of truth,
3. a system role declared in `globalOnlyRoles`.

Failing the boot is the intended severity: each of these describes a configuration whose access
decisions would be ambiguous, and an ambiguous authorization rule is worse than a server that
refuses to start.

> The framework's own documentation used to recommend
> `roleHierarchy: { viewer: 1, editor: 2, manager: 2, admin: 3, owner: 4 }` — i.e. exactly case 1.
> Projects that copied it had the escalation. The boot check now refuses that config.

### `strictMembershipRoles` (opt-in, deny by default)

With `multiTenancy.strictMembershipRoles: true`, only roles declared in `roleHierarchy` /
`additionalMembershipRoles` may be assigned **and** may satisfy a required role. Deliberately not
the default: a project may legitimately use exact-match roles that appear only in `@Roles()` and in
its membership data, and denying those at the guard by default would be a silent, fleet-wide
lockout. Turn it on for the strictest posture.

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

## `@Restricted` on NESTED data: only a DECLARED type is enforced (11.35.0)

`checkRestricted()` recurses, but until 11.35.0 it could not SEE anything one level down. The metadata
lookup reads from the value's class, and a nested value read out of MongoDB is a **plain object** —
`CoreModel.map()` is a shallow `Object.assign`, `prepareOutput()` maps only the target model, and
`ResponseModelInterceptor` only the top-level item. `Object` carries no `@Restricted` metadata, so
every nested restriction evaluated to "no restrictions at all". The same class WAS filtered when the
value happened to be an instance, which is why it went unnoticed for years.

Since 11.35.0 the nested-type registry that `@UnifiedField` already fills is read by
`checkRestricted()`, so a plain nested value is matched against the class its parent DECLARED — at
every level, and for every item of a declared array.

```typescript
@ObjectType()
class Insurance {
  @UnifiedField({ roles: RoleEnum.ADMIN, type: () => String })
  policyNumber?: string;                      // enforced from 11.35.0, returned in full before
}

@ObjectType()
class Patient extends CorePersistenceModel {
  @UnifiedField({ type: () => Insurance })    // ← the `type` is what makes the nesting enforceable
  insurance?: Insurance;

  @UnifiedField({ isArray: true, type: () => Insurance })
  insurances?: Insurance[];                   // every item, not just the first

  @UnifiedField({ isAny: true })
  extra?: any;                                // NOT reached — nothing declares what this holds
}
```

| Situation | Enforced? |
|-----------|-----------|
| Top-level property | yes, always |
| Nested value that IS an instance of its class | yes, always |
| Nested plain object / array with `@UnifiedField({ type: () => X })` | **yes, since 11.35.0** |
| Nested value with no declared type (`isAny`, bare `@Field`) | **no** — see below |
| Class-level `@Restricted` on a nested type | contents stripped, empty container remains (the `checkObjectItself: false` default) |

**An undeclared nested type stays unchecked on purpose.** Such a value is just as legitimately
free-form JSON, a `Map` or a scalar; failing closed there would strip vastly more than it protects. The
rule is therefore: *if a nested field must be protected, declare its type.*

**Upgrade note:** nested `@Restricted` fields start working. A response loses a nested restricted
field for callers who may not see it (correct), and an INPUT carrying one now throws 403 where it was
previously accepted. Audit nested `@Restricted` before upgrading.

## Tenant context on non-HTTP transports (11.35.0)

Every tenant decision the framework makes reads `RequestContext` (AsyncLocalStorage), which
`RequestContextMiddleware` installs — as **Express middleware**. A transport that does not traverse the
Express stack therefore had no context, and `mongooseTenantPlugin` reads "no context" as "system
operation, no filter". That is right for a cron job and wrong for a WebSocket.

| Transport | Context | Notes |
|-----------|---------|-------|
| HTTP (REST + GraphQL) | `RequestContextMiddleware` | `CoreTenantGuard` writes the validated tenant onto the request |
| GraphQL over WebSocket | **`execute`/`subscribe` wrappers, since 11.35.0** | `CoreModule` installs them on all three driver builders |
| Cron jobs, migrations, queue processors | none, by design | genuinely system-internal |

On the WebSocket path the tenant is resolved through `CoreTenantGuard.resolveTenantContext()` (reached
via `core-tenant-context.registry.ts`, because `src/core/common/**` must not import a provider that
only exists when multi-tenancy is configured): the handshake's tenant header is **validated against an
active membership**, and without a header the subscriber's memberships become `tenantIds`. A header
naming a tenant the subscriber does not belong to yields **no** tenant — the plugin's safety net then
refuses the read, which is strictly better than honouring an unvalidated header.

Two implementation details are load-bearing and easy to undo:

1. **The pair must sit inside `subscriptions`.** `ApolloDriver.start()` forwards only
   `{ schema, path, context, ...options.subscriptions }` to `GqlSubscriptionService`; a top-level
   `execute`/`subscribe` is dropped silently.
2. **The async iterator must be wrapped, not just the subscribe call.** graphql-js runs the per-event
   execution (`resolve`, `filter`, field resolvers) inside the iterator's `next()`, which the transport
   pulls long after `subscribe()` returned.

Both are pinned by `tests/unit/graphql-ws-context-wiring.spec.ts` (wiring) and
`tests/tenant-context-surfaces.e2e-spec.ts` (mechanism, over a real socket).

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
