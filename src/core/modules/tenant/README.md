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
  -> RequestContextMiddleware (reads header into context.tenantId)
  -> Auth Middleware (sets req.user)
  -> CoreTenantGuard (validates membership, sets req.activeTenantId)
  -> Mongoose Tenant Plugin (filters queries by context.tenantId)
```

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
},

// Pre-configured but disabled
multiTenancy: { enabled: false },
```

## Components

| Component              | Purpose                                                 |
| ---------------------- | ------------------------------------------------------- |
| `CoreTenantMemberModel` | User-tenant membership (join table with role + status) |
| `CoreTenantGuard`       | APP_GUARD validating tenant header + membership        |
| `CoreTenantService`     | Membership CRUD (add, remove, update role, find)       |
| `@TenantRoles()`        | Method decorator requiring minimum tenant role         |
| `@CurrentTenant()`      | Parameter decorator extracting validated tenant ID     |
| `TenantRole`            | Enum: OWNER, ADMIN, MEMBER                             |
| `TenantMemberStatus`    | Enum: ACTIVE, INVITED, SUSPENDED                       |

## Usage

### Protecting Endpoints

```typescript
import { TenantRoles, CurrentTenant, TenantRole } from '@lenne.tech/nest-server';

@Controller('projects')
export class ProjectController {
  @Get()
  @TenantRoles(TenantRole.MEMBER)
  async list(@CurrentTenant() tenantId: string) {
    return this.projectService.find({ tenantId });
  }

  @Delete(':id')
  @TenantRoles(TenantRole.ADMIN)
  async delete(@Param('id') id: string) {
    return this.projectService.delete(id);
  }
}
```

### Role Hierarchy

```
OWNER (3) > ADMIN (2) > MEMBER (1)
```

### Admin Bypass

System admins (`RoleEnum.ADMIN`) bypass the membership check by default.
Disable with `multiTenancy: { adminBypass: false }`.

### Filtering Without Header

| User State | Filter Applied |
|-----------|---------------|
| Not authenticated | No filter (public routes) |
| Authenticated | `{ tenantId: { $in: [user's tenant IDs] } }` |
| Authenticated, no memberships | `{ tenantId: { $in: [] } }` (sees nothing) |

## Extending via Module Inheritance

```typescript
@Injectable()
export class TenantService extends CoreTenantService {
  override async addMember(tenantId: string, userId: string, role: TenantRole) {
    const member = await super.addMember(tenantId, userId, role);
    await this.notificationService.sendInvite(userId, tenantId);
    return member;
  }
}

// module
CoreTenantModule.forRoot({ service: TenantService });
```

## Security Notes

> **IMPORTANT:** The Mongoose tenant plugin filters data by `tenantId` based on the raw request header. On routes **without** `@TenantRoles()`, any client that sends an `X-Tenant-Id` header can access that tenant's data without membership validation. **Always use `@TenantRoles(TenantRole.MEMBER)` on any endpoint that returns tenant-scoped data.**

> **Explicit tenantId on writes:** The plugin only auto-sets `tenantId` on new documents when no explicit value is provided. Service-layer code that accepts user-supplied `tenantId` as a creation parameter could allow cross-tenant writes. Never pass user-supplied `tenantId` directly to `create()` or `new Model()`.

### Secured Membership Controller Example

When building a tenant management UI, protect membership endpoints with both system and tenant roles:

```typescript
@Controller('tenants/:tenantId/members')
export class TenantMemberController {
  @Get()
  @Roles(RoleEnum.S_USER)
  @TenantRoles(TenantRole.ADMIN)
  async listMembers(@CurrentTenant() tenantId: string) {
    return this.tenantService.findMemberships(tenantId);
  }

  @Post()
  @Roles(RoleEnum.S_USER)
  @TenantRoles(TenantRole.OWNER)
  async addMember(@CurrentTenant() tenantId: string, @Body() body: AddMemberDto) {
    return this.tenantService.addMember(tenantId, body.userId, body.role);
  }
}
```

## Related

- [Integration Checklist](./INTEGRATION-CHECKLIST.md)
- [Configurable Features](../../../.claude/rules/configurable-features.md)
- [Request Lifecycle](../../../docs/REQUEST-LIFECYCLE.md)
