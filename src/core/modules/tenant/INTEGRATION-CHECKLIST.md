# Tenant Module Integration Checklist

## Reference Implementation

- Local: `node_modules/@lenne.tech/nest-server/src/server/modules/tenant/` (when available)
- GitHub: https://github.com/lenneTech/nest-server/tree/develop/src/core/modules/tenant

## Quick Start (Auto-Registration)

For projects that don't need custom tenant logic:

```typescript
// config.env.ts
multiTenancy: {},
```

That's it. CoreModule auto-registers the tenant module, guard, and service.

> **Note:** Auto-registration uses default model/guard/service. For custom implementations, use manual registration with `CoreTenantModule.forRoot({ service: CustomTenantService })` in your ServerModule.

## Custom Integration (Manual Registration)

### 1. Create TenantMember Model

**Create:** `src/server/modules/tenant/tenant-member.model.ts`

```typescript
import { Schema } from '@nestjs/mongoose';
import { CoreTenantMemberModel } from '@lenne.tech/nest-server';

@Schema({ timestamps: true })
export class TenantMember extends CoreTenantMemberModel {
  // Add custom fields here if needed
}
```

### 2. Create Custom Service (Optional)

**Create:** `src/server/modules/tenant/tenant.service.ts`

Extend `CoreTenantService` to add custom logic (notifications, tenant creation, etc.).

### 3. Register in ServerModule

**Modify:** `src/server/server.module.ts`

```typescript
import { CoreTenantModule } from '@lenne.tech/nest-server';
import { TenantMember } from './modules/tenant/tenant-member.model';
import { TenantService } from './modules/tenant/tenant.service';

@Module({
  imports: [
    CoreTenantModule.forRoot({
      memberModel: TenantMember,
      service: TenantService,
    }),
    // ...
  ],
})
export class ServerModule {}
```

### 4. Define Hierarchy Roles (Recommended)

**Create:** `src/server/modules/tenant/roles.ts`

```typescript
import { createHierarchyRoles } from '@lenne.tech/nest-server';

// Must match roleHierarchy in config.env.ts (or use DefaultHR for defaults)
export const HR = createHierarchyRoles({ member: 1, manager: 2, owner: 3 });
// HR.MEMBER = 'member', HR.MANAGER = 'manager', HR.OWNER = 'owner'
```

Or use the built-in `DefaultHR` for the default hierarchy:

```typescript
import { DefaultHR } from '@lenne.tech/nest-server';
// DefaultHR.MEMBER, DefaultHR.MANAGER, DefaultHR.OWNER
```

### 5. Add Tenant Header to API Calls

All tenant-scoped requests must include:

```
X-Tenant-Id: <tenant-id>
```

### 6. Add tenantId to Scoped Models

Models that should be tenant-scoped need a `tenantId` field:

```typescript
@Prop({ type: String })
tenantId: string;
```

The tenant plugin automatically filters and populates this field.

### 7. Use Hierarchy Roles on Protected Endpoints

```typescript
import { Roles, CurrentTenant, DefaultHR } from '@lenne.tech/nest-server';

@Roles(DefaultHR.MEMBER)   // any active member
async listItems(@CurrentTenant() tenantId: string) { ... }

@Roles(DefaultHR.MANAGER)  // at least manager level
async updateItem(...) { ... }

@Roles(DefaultHR.OWNER)    // highest level only
async deleteItem(...) { ... }
```

Normal (non-hierarchy) roles also work:

```typescript
@Roles('auditor')  // exact match against membership.role
async viewAuditLog(...) { ... }
```

### 8. Skip Tenant Check for Non-Tenant Endpoints

Use `@SkipTenantCheck()` for endpoints that intentionally work without tenant context:

```typescript
import { SkipTenantCheck, Roles, RoleEnum } from '@lenne.tech/nest-server';

@SkipTenantCheck()
@Roles(RoleEnum.S_USER)
async listMyTenants() { ... }
```

## Verification Checklist

- [ ] `pnpm run build` succeeds
- [ ] `pnpm test` passes
- [ ] Request with `X-Tenant-Id` header only returns tenant data
- [ ] Request without header + hierarchy role checks user.roles and filters tenantIds
- [ ] Admin user can access any tenant (if adminBypass: true)
- [ ] Non-member gets 403 "Not a member of this tenant"
- [ ] Unauthenticated + header → 403 "Authentication required for tenant access"
- [ ] Public endpoint accessing tenantId-schema without context throws 403 (Safety Net)

## Security

> **Defense-in-Depth:** The guard validates membership and sets `req.tenantId`. The Mongoose plugin only uses this validated value (via RequestContext) — never the raw header. Additionally, the plugin's Safety Net throws `ForbiddenException` when a tenantId-scoped schema is accessed without valid tenant context.

> **Tenant overrides user.roles:** When a tenant header is present, only `membership.role` is checked. `user.roles` is ignored (except ADMIN bypass). This prevents users from claiming higher privileges via `user.roles` when operating within a specific tenant.

> **Cross-tenant writes:** Never pass user-supplied `tenantId` directly to `create()` or `new Model()`. The plugin only auto-sets `tenantId` on new documents when no explicit value is provided. Accepting user-supplied values bypasses the auto-set and could allow cross-tenant writes.

## Common Mistakes

| Mistake                                          | Symptom                            | Fix                                                                        |
| ------------------------------------------------ | ---------------------------------- | -------------------------------------------------------------------------- |
| Missing `tenantId` field on model                | Data not filtered by tenant        | Add `@Prop({ type: String }) tenantId: string`                             |
| Forgetting `X-Tenant-Id` header                  | 403 or Safety Net exception        | Add header to all tenant-scoped API calls                                  |
| Using only `@Roles(S_USER)` for tenant endpoints | No tenant membership check         | Use `@Roles(DefaultHR.MEMBER)` for tenant-level access                     |
| Querying membership without bypass               | Empty results due to tenant filter | Use `RequestContext.runWithBypassTenantGuard()`                            |
| Public endpoint accessing tenantId-schema        | 403 Safety Net exception           | Use `@SkipTenantCheck()` + `RequestContext.runWithBypassTenantGuard()`     |
| Passing user-supplied tenantId to create()       | Cross-tenant write possible        | Let plugin auto-set tenantId from context                                  |
| Custom hierarchy doesn't match config            | Roles fail unexpectedly            | Ensure `createHierarchyRoles()` input matches `multiTenancy.roleHierarchy` |