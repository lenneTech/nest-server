# System Setup Integration Checklist

**For enabling initial admin creation on fresh deployments in projects using `@lenne.tech/nest-server`.**

> **Note:** System setup is **disabled by default**. This checklist shows how to enable it. No custom code is needed unless you want to extend the controller.

---

## Do You Need This Checklist?

| Scenario | Checklist Needed? |
|----------|-------------------|
| Fresh deployment needs initial admin creation | Yes - Step 1 |
| Using `disableSignUp: true` and need first admin | Yes - Step 1 |
| Custom setup logic (extra fields, notifications) | Yes - Steps 1 + 2 |
| Don't need initial admin creation | No |

---

## Reference Implementation

**Local (in your node_modules):**
```
node_modules/@lenne.tech/nest-server/src/core/modules/system-setup/
```

**GitHub:**
https://github.com/lenneTech/nest-server/tree/develop/src/core/modules/system-setup

---

## Step 1: Enable in Configuration (Required)

**Edit:** `src/config.env.ts`

Add `systemSetup: {}` to your environment configuration:

```typescript
// config.env.ts
{
  // ... other config

  systemSetup: {},

  // BetterAuth must also be enabled
  betterAuth: {
    // ...
  },
}
```

That's it. The module is auto-registered when the config is present.

---

## Step 2: Custom Controller (Optional)

Only needed if you want to add extra validation, logging, or custom fields.

**Create:** `src/server/modules/system-setup/system-setup.controller.ts`

```typescript
import { Controller } from '@nestjs/common';
import { CoreSystemSetupController, Roles, RoleEnum } from '@lenne.tech/nest-server';

@Controller('api/system-setup')
@Roles(RoleEnum.ADMIN)
export class SystemSetupController extends CoreSystemSetupController {
  // Override methods here for custom logic
}
```

> **Note:** Unlike other modules, the SystemSetup module auto-registers its controller via CoreModule. To use a custom controller, you would need to disable auto-registration and register your own module.

---

## Verification Checklist

- [ ] `npm run build` succeeds
- [ ] `npm test` passes
- [ ] `GET /api/system-setup/status` returns `{ needsSetup: true }` on empty database
- [ ] `POST /api/system-setup/init` creates admin user with correct role
- [ ] `GET /api/system-setup/status` returns `{ needsSetup: false }` after init
- [ ] `POST /api/system-setup/init` returns 403 when users already exist

---

## Common Mistakes

| Mistake | Symptom | Fix |
|---------|---------|-----|
| Missing `systemSetup` in config | 404 on `/api/system-setup/*` | Add `systemSetup: {}` to config.env.ts |
| BetterAuth not enabled | 403 "System setup requires BetterAuth" | Ensure `betterAuth` is configured |
| Calling init with existing users | 403 "System setup not available" | Init only works on empty database |
| Password too short | 400 validation error | Password must be at least 8 characters |

---

## Detailed Documentation

- **README.md:** `node_modules/@lenne.tech/nest-server/src/core/modules/system-setup/README.md`
- **GitHub:** https://github.com/lenneTech/nest-server/blob/develop/src/core/modules/system-setup/README.md
