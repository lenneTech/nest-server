# System Setup Integration Checklist

**For initial admin creation on fresh deployments in projects using `@lenne.tech/nest-server`.**

> **Note:** System setup is **enabled by default** when BetterAuth is active. Locally (`local`, `ci`, `e2e`) the REST
> endpoints work without configuration. **In a deployed environment `POST /system-setup/init` is closed since 12.4.0**:
> provision the first admin via ENV (Step 1), or open the HTTP init on purpose (Step 1b).

---

## Do You Need This Checklist?

| Scenario                                             | Action Needed                                   |
| ---------------------------------------------------- | ----------------------------------------------- |
| Local development / e2e tests create the first admin | None - the HTTP init is open there by default   |
| Deployed instance needs its first admin              | Set ENV variables (Step 1) - recommended        |
| Deployed instance must be set up through the UI      | Open the HTTP init with a token (Step 1b)       |
| Want to disable system setup                         | Set `systemSetup: { enabled: false }` in config |
| Custom setup logic (extra fields, notifications)     | Step 2 (Custom Controller)                      |

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
# .env or Docker environment — every segment in SCREAMING_SNAKE_CASE
NSC__SYSTEM_SETUP__INITIAL_ADMIN__EMAIL=admin@example.com
NSC__SYSTEM_SETUP__INITIAL_ADMIN__PASSWORD=YourSecurePassword123!
NSC__SYSTEM_SETUP__INITIAL_ADMIN__NAME=Admin  # optional
```

**WHY SCREAMING_SNAKE_CASE?** The environment reader lowercases every segment it does not split at `_`. The camelCase
form `NSC__systemSetup__initialAdmin__email` (shown in this checklist until 12.4.0) is therefore never read, and no
admin is created. Since 12.4.0 the boot warns about such a variable.

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

## Step 1b: Open the HTTP init on a deployed instance (Optional, 12.4.0+)

Only when the first admin must be created through the UI on a deployed stage:

```bash
NSC__SYSTEM_SETUP__HTTP_INIT__TOKEN=<secret of at least 16 characters>   # recommended
# or, without a token (whoever reaches the API first becomes admin):
NSC__SYSTEM_SETUP__HTTP_INIT=true
```

The frontend sends the token in the `X-System-Setup-Token` header; `GET /system-setup/status` tells it with
`httpInitEnabled` / `httpInitTokenRequired` whether to show the form and a token field.

**WHY closed by default?** The init is anonymous. On a deployment without `initialAdmin` it made whoever called it
first the administrator, until the first sign-up.

Remove the setting once the admin exists — the init is locked from then on anyway.

---

## Step 2: Custom Controller (Optional)

Only needed if you want to add extra validation, logging, or custom fields.

**Create:** `src/server/modules/system-setup/system-setup.controller.ts`

```typescript
import { Controller } from '@nestjs/common';
import { CoreSystemSetupController, Roles, RoleEnum } from '@lenne.tech/nest-server';

@Controller('system-setup')
@Roles(RoleEnum.ADMIN)
export class SystemSetupController extends CoreSystemSetupController {
  // Override methods here for custom logic
}
```

> **Note:** The SystemSetup module auto-registers its controller via CoreModule. To use a custom controller, you would need to disable auto-registration and register your own module.
>
> **An override of `createInitialAdmin()` must call `this.systemSetupService.assertHttpInitAllowed(token)` first**
> (the token from the `x-system-setup-token` header), or it opens the anonymous init in every environment.

---

## Verification Checklist

- [ ] `npm run build` succeeds
- [ ] `npm test` passes
- [ ] `GET /system-setup/status` returns `{ needsSetup: true }` on empty database
- [ ] Locally: `httpInitEnabled: true`, and `POST /system-setup/init` creates admin user with correct role
- [ ] Deployed stage without `httpInit`: `httpInitEnabled: false`, and the init answers 403 `LTNS_0053`
- [ ] Deployed stage with `initialAdmin`: the admin exists after the first start
- [ ] `GET /system-setup/status` returns `{ needsSetup: false }` after init
- [ ] `POST /system-setup/init` returns 403 when users already exist

---

## Common Mistakes

| Mistake                                       | Symptom                          | Fix                                                                                                                                                                |
| --------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| BetterAuth not enabled                        | 404 on endpoints or 403 on init  | Ensure `betterAuth` is configured                                                                                                                                  |
| Calling init with existing users              | 403 "System setup not available" | Init requires an empty `users` collection                                                                                                                          |
| Re-running init after a successful setup      | 403, even with an empty `users`  | The claim marker in `system-setup-locks` outlives a SUCCESSFUL setup (it is released only on failure) — drop that collection too, or wait 5 min for it to go stale |
| Password too short                            | 400 validation error             | Password must be at least 8 characters                                                                                                                             |
| Missing ENV password                          | Auto-creation silently skipped   | Set both `email` and `password` ENV vars                                                                                                                           |
| camelCase ENV names (`NSC__systemSetup__…`)   | No admin, boot warning           | Write every segment in SCREAMING_SNAKE_CASE: `NSC__SYSTEM_SETUP__INITIAL_ADMIN__EMAIL`                                                                             |
| Setting up a deployed stage through the UI    | 403 `LTNS_0053`                  | Set `initialAdmin` via ENV, or open the init with `NSC__SYSTEM_SETUP__HTTP_INIT__TOKEN`                                                                            |
| `httpInit: { token: process.env.X }`, X unset | 403 `LTNS_0053`, boot error      | A missing, empty or short token keeps the init closed on purpose — set the variable                                                                                |
| `systemSetup: { enabled: false }` in config   | 404 on endpoints                 | Remove the explicit disable                                                                                                                                        |

---

## Detailed Documentation

- **README.md:** `node_modules/@lenne.tech/nest-server/src/core/modules/system-setup/README.md`
- **GitHub:** https://github.com/lenneTech/nest-server/blob/develop/src/core/modules/system-setup/README.md