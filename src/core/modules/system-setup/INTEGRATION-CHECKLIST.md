# System Setup Integration Checklist

**For initial admin creation on fresh deployments in projects using `@lenne.tech/nest-server`.**

> **Note:** System setup is **enabled by default** when BetterAuth is active. No explicit configuration is needed for the REST endpoints to work.

---

## Do You Need This Checklist?

| Scenario | Action Needed |
|----------|---------------|
| Fresh deployment needs initial admin creation | None - endpoints are available by default |
| Automated deployment (Docker/CI) needs auto-creation | Set ENV variables (Step 1) |
| Want to disable system setup | Set `systemSetup: { enabled: false }` in config |
| Custom setup logic (extra fields, notifications) | Step 2 (Custom Controller) |

---

## Reference Implementation

**Local (in your node_modules):**
```
node_modules/@lenne.tech/nest-server/src/core/modules/system-setup/
```

**GitHub:**
https://github.com/lenneTech/nest-server/tree/develop/src/core/modules/system-setup

---

## Step 1: Auto-Creation via ENV (Optional)

For automated deployments where no manual REST call is possible:

```bash
# .env or Docker environment
NSC__systemSetup__initialAdmin__email=admin@example.com
NSC__systemSetup__initialAdmin__password=YourSecurePassword123!
NSC__systemSetup__initialAdmin__name=Admin  # optional
```

Or in `config.env.ts`:

```typescript
systemSetup: {
  initialAdmin: {
    email: process.env.INITIAL_ADMIN_EMAIL,
    password: process.env.INITIAL_ADMIN_PASSWORD,
  },
},
```

The admin is created automatically on server start when zero users exist.

**Security:** Remove credentials from ENV after the first successful deployment.

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

> **Note:** The SystemSetup module auto-registers its controller via CoreModule. To use a custom controller, you would need to disable auto-registration and register your own module.

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
| BetterAuth not enabled | 404 on endpoints or 403 on init | Ensure `betterAuth` is configured |
| Calling init with existing users | 403 "System setup not available" | Init only works on empty database |
| Password too short | 400 validation error | Password must be at least 8 characters |
| Missing ENV password | Auto-creation silently skipped | Set both `email` and `password` ENV vars |
| `systemSetup: { enabled: false }` in config | 404 on endpoints | Remove the explicit disable |

---

## Detailed Documentation

- **README.md:** `node_modules/@lenne.tech/nest-server/src/core/modules/system-setup/README.md`
- **GitHub:** https://github.com/lenneTech/nest-server/blob/develop/src/core/modules/system-setup/README.md
