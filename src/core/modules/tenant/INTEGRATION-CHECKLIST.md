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

### 4. Add Tenant Header to API Calls

All tenant-scoped requests must include:

```
X-Tenant-Id: <tenant-id>
```

### 5. Add tenantId to Scoped Models

Models that should be tenant-scoped need a `tenantId` field:

```typescript
@Prop({ type: String })
tenantId: string;
```

The tenant plugin automatically filters and populates this field.

### 6. Use @TenantRoles() on Protected Endpoints

```typescript
@TenantRoles(TenantRole.MEMBER)
async listItems(@CurrentTenant() tenantId: string) { ... }
```

## Verification Checklist

- [ ] `pnpm run build` succeeds
- [ ] `pnpm test` passes
- [ ] Request with `X-Tenant-Id` header only returns tenant data
- [ ] Request without header on tenant route returns 403
- [ ] Admin user can access any tenant (if adminBypass: true)
- [ ] Non-member gets 403

## Security

> **IMPORTANT:** All endpoints returning tenant-scoped data MUST use `@TenantRoles(TenantRole.MEMBER)`. Without this decorator, any client sending an `X-Tenant-Id` header can access that tenant's data without membership validation.

## Common Mistakes

| Mistake | Symptom | Fix |
| ------- | ------- | --- |
| Missing `tenantId` field on model | Data not filtered by tenant | Add `@Prop({ type: String }) tenantId: string` |
| Forgetting `X-Tenant-Id` header | 403 or unfiltered data | Add header to all tenant-scoped API calls |
| Using `@Roles()` instead of `@TenantRoles()` | No tenant membership check | Use `@TenantRoles()` for tenant-level access |
| Querying membership without bypass | Empty results due to tenant filter | Use `RequestContext.runWithBypassTenantGuard()` |
