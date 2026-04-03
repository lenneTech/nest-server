# CoreTenantModule

Header-based multi-tenancy for @lenne.tech/nest-server.

## Overview

Enables tenant-based data isolation where:

- Users can be members of multiple tenants
- The active tenant is selected per-request via `X-Tenant-Id` header
- Data is automatically filtered by tenant (via the existing Mongoose tenant plugin)
- Tenant membership and roles are validated per-request

## Architecture

```
Request + X-Tenant-Id Header
  -> RequestContextMiddleware (lazy getters for tenant context)
  -> Auth Middleware (sets req.user)
  -> CoreTenantGuard (validates membership, sets req.tenantId)
  -> Mongoose Tenant Plugin (filters queries by context.tenantId)
```

**Defense-in-depth:** Two layers of protection:

1. **Guard level:** CoreTenantGuard validates membership and sets `tenantId` (only after successful check)
2. **Plugin level:** Safety Net — throws `ForbiddenException` when a tenantId-scoped schema is accessed without valid tenant context

## Configuration

```typescript
// config.env.ts

// Disabled (default) - zero overhead
// multiTenancy: undefined

// Enabled with defaults
multiTenancy: {},

// Enabled with custom settings
multiTenancy: {
  headerName: 'x-tenant-id',        // Header name (default: 'x-tenant-id')
  membershipModel: 'TenantMember',  // Mongoose model name (default)
  adminBypass: true,                 // System admins bypass membership (default: true)
  excludeSchemas: ['User', 'Session'], // Schemas without tenant filtering
  cacheTtlMs: 30000,                // Membership cache TTL in ms (default: 30s, 0 = disabled)
  roleHierarchy: {                   // Custom role hierarchy (default below)
    member: 1,
    manager: 2,
    owner: 3,
  },
},

// Pre-configured but disabled
multiTenancy: { enabled: false },
```

## Components

| Component                | Purpose                                                |
| ------------------------ | ------------------------------------------------------ |
| `CoreTenantMemberModel`  | User-tenant membership (join table with role + status) |
| `CoreTenantGuard`        | APP_GUARD validating tenant header + membership        |
| `CoreTenantService`      | Membership CRUD (add, remove, update role, find)       |
| `@SkipTenantCheck()`     | Method/class decorator to skip tenant validation       |
| `@CurrentTenant()`       | Parameter decorator extracting validated tenant ID     |
| `TenantMemberStatus`     | Enum: ACTIVE, INVITED, SUSPENDED                       |
| `DefaultHR`              | Type-safe constants for default hierarchy roles        |
| `createHierarchyRoles()` | Generate type-safe constants from custom hierarchy     |

## Usage

### Protecting Endpoints with Hierarchy Roles

Use `@Roles()` with hierarchy role strings. Higher levels include lower levels (level comparison).

```typescript
import { Roles, CurrentTenant, DefaultHR } from '@lenne.tech/nest-server';

@Controller('projects')
export class ProjectController {
  @Get()
  @Roles(DefaultHR.MEMBER) // any active member (level >= 1)
  async list(@CurrentTenant() tenantId: string) {
    return this.projectService.find({ tenantId });
  }

  @Put(':id')
  @Roles(DefaultHR.MANAGER) // at least manager level (level >= 2)
  async update(@Param('id') id: string, @Body() body: UpdateDto) {
    return this.projectService.update(id, body);
  }

  @Delete(':id')
  @Roles(DefaultHR.OWNER) // highest level only (level >= 3)
  async delete(@Param('id') id: string) {
    return this.projectService.delete(id);
  }
}
```

### Hierarchy Roles

The role hierarchy defines levels where higher includes lower:

| Role Key  | Level | Can Access                 |
| --------- | ----- | -------------------------- |
| `owner`   | 3     | Everything                 |
| `manager` | 2     | MANAGER + MEMBER endpoints |
| `member`  | 1     | MEMBER endpoints only      |

Multiple roles can share the same level (e.g., `editor: 2, manager: 2` → equivalent access).

### Custom Hierarchy

```typescript
// config.env.ts
multiTenancy: {
  roleHierarchy: { viewer: 1, editor: 2, manager: 2, admin: 3, owner: 4 },
}

// roles.ts — type-safe constants
import { createHierarchyRoles } from '@lenne.tech/nest-server';
export const HR = createHierarchyRoles({ viewer: 1, editor: 2, manager: 2, admin: 3, owner: 4 });
// HR.VIEWER = 'viewer', HR.EDITOR = 'editor', HR.MANAGER = 'manager', HR.ADMIN = 'admin', HR.OWNER = 'owner'

// resolver.ts
@Roles(HR.EDITOR)  // requires level >= 2 (editor, manager, admin, owner all pass)
```

### Normal (Non-Hierarchy) Roles

Roles not in `roleHierarchy` use exact match — no higher role can compensate:

```typescript
// membership.role = 'auditor' → @Roles('auditor') passes, @Roles('manager') fails
@Roles('auditor')
async auditLog(@CurrentTenant() tenantId: string) { ... }
```

### Tenant Context Rule

**When a tenant header is present:** Only `membership.role` is checked. `user.roles` is ignored (except ADMIN bypass).

**When no tenant header:** `user.roles` is checked instead. Hierarchy roles use level comparison, normal roles use exact match.

```typescript
// Example: user.roles=['manager'], tenant membership.role='member'
// @Roles(DefaultHR.MANAGER) with X-Tenant-Id header → 403 (member < manager)
// @Roles(DefaultHR.MANAGER) without header → 200 (user.roles manager(2) >= manager(2))
```

### Skipping Tenant Checks

Use `@SkipTenantCheck()` for endpoints that intentionally work without tenant context:

```typescript
@SkipTenantCheck()
@Roles(RoleEnum.S_USER)
async listMyTenants() { ... }
```

Note: `@SkipTenantCheck()` with hierarchy roles still checks `user.roles` (no tenant context).

### Admin Bypass

System admins (`RoleEnum.ADMIN`) bypass the membership check by default.
Disable with `multiTenancy: { adminBypass: false }`.

### Filtering Without Header

| User State                     | Filter Applied                                                      |
| ------------------------------ | ------------------------------------------------------------------- |
| Not authenticated, no context  | Safety Net: `ForbiddenException` on tenantId-schemas                |
| Authenticated, no memberships  | Safety Net: `ForbiddenException` on tenantId-schemas                |
| Authenticated, has memberships | `{ tenantId: { $in: [user's tenant IDs] } }`                        |
| Authenticated + hierarchy role | `{ tenantId: { $in: [qualified tenant IDs] } }` (filtered by level) |
| Admin without header           | No filter (sees all data via `isAdminBypass`)                       |

## Extending via Module Inheritance

```typescript
@Injectable()
export class TenantService extends CoreTenantService {
  override async addMember(tenantId: string, userId: string, role?: string) {
    const member = await super.addMember(tenantId, userId, role);
    await this.notificationService.sendInvite(userId, tenantId);
    return member;
  }
}

// module
CoreTenantModule.forRoot({ service: TenantService });
```

## Performance Considerations

### Membership Cache (since 11.21.1)

The `CoreTenantGuard` uses an in-memory TTL cache for membership lookups and tenant ID resolution. This avoids repeated DB queries when the same user accesses the same tenant across multiple requests.

```typescript
// config.env.ts — configure or disable the cache
multiTenancy: {
  cacheTtlMs: 30000, // default: 30s. Set to 0 to disable.
}
```

**Cache behavior:**

- **Positive-only:** Only active memberships are cached. Non-member lookups always hit the DB (security-first).
- **Auto-invalidation:** `CoreTenantService.addMember/removeMember/updateMemberRole` automatically invalidate the cache.
- **Config-change detection:** Cache is flushed when `multiTenancy` config changes (e.g., `roleHierarchy` update).
- **Bounded:** Max 500 entries with FIFO eviction. Memory overhead: ~100-250 KB.

**Important:** The cache is process-local. In horizontally scaled deployments (multiple instances), membership changes on one instance are not reflected on other instances until the TTL expires. Set `cacheTtlMs: 0` for security-sensitive deployments.

### Manual Cache Invalidation

When extending `CoreTenantService` with custom membership mutation methods, call `invalidateUser()` after changes:

```typescript
@Injectable()
export class TenantService extends CoreTenantService {
  async customMembershipChange(tenantId: string, userId: string) {
    // ... your logic ...
    this.tenantGuard?.invalidateUser(userId);
  }
}
```

Use `invalidateAll()` to flush the entire cache (e.g., after bulk operations).

### SkipTenantCheck

For high-frequency endpoints that don't access tenant-scoped data, use `@SkipTenantCheck()` to avoid the membership lookup entirely.

## Security Notes

> **Defense-in-Depth:** The Mongoose tenant plugin uses `tenantId` from `RequestContext`, which is only set by `CoreTenantGuard` after successful membership validation. The raw `X-Tenant-Id` header is **never** used directly for filtering. Even if the guard is bypassed (e.g., via `@SkipTenantCheck()`), the plugin's Safety Net throws `ForbiddenException` when a tenantId-scoped schema is accessed without valid tenant context.

> **Explicit tenantId on writes:** The plugin only auto-sets `tenantId` on new documents when no explicit value is provided. Service-layer code that accepts user-supplied `tenantId` as a creation parameter could allow cross-tenant writes. Never pass user-supplied `tenantId` directly to `create()` or `new Model()`.

### Secured Membership Controller Example

When building a tenant management UI, protect membership endpoints:

```typescript
@Controller('tenants/:tenantId/members')
export class TenantMemberController {
  @Get()
  @Roles(DefaultHR.MANAGER)
  async listMembers(@CurrentTenant() tenantId: string) {
    return this.tenantService.findMemberships(tenantId);
  }

  @Post()
  @Roles(DefaultHR.OWNER)
  async addMember(@CurrentTenant() tenantId: string, @Body() body: AddMemberDto) {
    return this.tenantService.addMember(tenantId, body.userId, body.role);
  }
}
```

### BetterAuth (IAM) Integration

When both Multi-Tenancy and BetterAuth are active, IAM endpoints (sign-up, sign-in, sign-out,
session, etc.) automatically skip tenant validation by default. This is because authentication
typically happens before tenant context is established.

**Behavior with `skipTenantCheck: true` (default):**

- No `X-Tenant-Id` header → skip tenant validation, proceed without tenant context
- `X-Tenant-Id` header IS provided → validate normally (membership check, tenant context set)

The tenant is optional but respected when present. This allows tenant-aware auth flows
(subdomain-based, invite links, etc.) to coexist with the default cross-tenant behavior.

**Configuration:**

```typescript
// config.env.ts — Default: skip tenant validation on IAM endpoints (most projects)
betterAuth: {
  skipTenantCheck: true, // (default) No X-Tenant-Id header → skip; header present → validate
}

// config.env.ts — Tenant-aware auth (subdomain-based, invite links, SSO per tenant)
betterAuth: {
  skipTenantCheck: false, // IAM endpoints ALWAYS require valid X-Tenant-Id header
}
```

When `skipTenantCheck: false`, IAM endpoints will require a valid `X-Tenant-Id` header
and the user must be a member of that tenant for protected endpoints.

## Related

- [Integration Checklist](./INTEGRATION-CHECKLIST.md)
- [Configurable Features](../../../.claude/rules/configurable-features.md)

- [Request Lifecycle](../../../docs/REQUEST-LIFECYCLE.md)