# TUS Integration Checklist

**For customizing TUS uploads in projects using `@lenne.tech/nest-server`.**

> **Note:** TUS is **enabled by default** with no configuration needed. This checklist is only for projects that need to customize behavior (e.g., widen or narrow who may upload).

> **Since 11.33.0 uploads require a signed-in user.** `tus.roles` defaults to `[RoleEnum.S_USER]`; it used to be `S_EVERYONE`. If your project accepts attachments on a public form, you must opt back in explicitly — see Step 0.

---

## Do You Need This Checklist?

| Scenario                                           | Checklist Needed?                                    |
| -------------------------------------------------- | ---------------------------------------------------- |
| Use TUS with defaults (signed-in users may upload) | No - works automatically                             |
| **Allow anonymous uploads** (public form)          | **Yes - Step 0** (the default no longer allows this) |
| Restrict uploads to specific roles                 | Yes - Step 0                                         |
| Custom upload handling (notifications, etc.)       | Yes - Step 2                                         |
| Hard-code a policy that config must NOT change     | Yes - Step 1                                         |
| Disable TUS completely                             | No - just use `TusModule.forRoot({ config: false })` |

---

## Step 0: Configure `tus.roles` (Who May Upload)

This is the normal way to set TUS permissions — no controller subclass needed.

```typescript
// src/config.env.ts
tus: {
  roles: [RoleEnum.S_USER],          // default since 11.33.0
  // roles: [RoleEnum.S_EVERYONE],   // opt back in to anonymous uploads (public form)
  // roles: ['editor', 'contributor'], // project-specific roles work too
},
```

Plain role **strings**, exactly like a hand-written `@Roles()` call, so project roles work alongside
the `RoleEnum` system roles.

**Three properties worth knowing:**

1. **`roles: []` is rejected**, with a warning, and the default applies. An all-empty role set reads
   to the guards as "no roles required" and returns `true` — honouring it literally would _open_ the
   endpoints, the exact opposite of what someone writing `[]` intends. Same for a non-array or an
   array holding a non-string.

2. **`OPTIONS` stays public regardless.** `handleTusOptions` / `handleTusOptionsWithId` keep their
   own `@Roles(RoleEnum.S_EVERYONE)`, because that is the CORS preflight — browsers send it
   **without credentials**, and it returns server capabilities only. Gating it would make every
   browser upload fail before the first byte.

3. **Pair it with the file roles.** A TUS upload lands in the same store `file.downloadRoles`
   guards (default `[RoleEnum.ADMIN]`), so with both at their defaults a signed-in user may upload
   but cannot read the result back. Either widen `file.downloadRoles`, or write an owner into the
   metadata at upload time and authorize per file in `CoreFileService.checkRights()`. TUS uploads
   already carry `metadata.tusUploadId` plus the original TUS metadata.

**Verify:** `curl -X OPTIONS <baseUrl>/tus` still answers `204` with the TUS capability headers,
while `POST /tus` without a token answers `401`.

---

## Reference Implementation

**Local (in your node_modules):**

```
node_modules/@lenne.tech/nest-server/src/server/server.module.ts
```

**GitHub:**
https://github.com/lenneTech/nest-server/tree/develop/src/server

---

## Step 1: Custom Controller (Custom Upload Logic)

> Only needed for custom handler behaviour. For "who may upload", use Step 0 — it needs no subclass.

**Create:** `src/server/modules/tus/tus.controller.ts`

```typescript
import { Controller } from '@nestjs/common';
import { CoreTusController } from '@lenne.tech/nest-server';

@Controller('tus')
export class TusController extends CoreTusController {
  // Inherits the handlers; `tus.roles` from config applies to them.
  // Override methods here for custom logic.
}
```

**How `tus.roles` reaches a custom controller — and why you should not fight it with `@Roles()`:**

`TusModule.forRoot()` calls `applyRoles()` on the class it actually registers, writing the configured
roles onto that class **and** onto its `handleTus` / `handleTusWithId`, resolved through the
prototype chain. `forRoot()` runs after the controller's decorators have been evaluated, so it wins:

| You write on the subclass                            | Effective at runtime                                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Nothing                                              | `tus.roles` (config)                                                                                                   |
| A class-level `@Roles(...)`                          | `tus.roles` — overwritten by `applyRoles()`                                                                            |
| A re-declared `handleTus` with its own `@Roles(...)` | `tus.roles` — overwritten too, because `applyRoles()` writes onto whichever function `prototype.handleTus` resolves to |

So `tus.roles` is the single source of truth for TUS permissions. If you need a policy that
configuration cannot change, either give your handler a **different method name** (`applyRoles()`
only targets `handleTus` / `handleTusWithId`), or register the controller outside `TusModule`.

> This differs from the file module, where `applyFileRoles()` targets the **base** class methods by
> name — there an override genuinely does opt out.

**Update ServerModule:**

```typescript
// src/server/server.module.ts
import { TusModule } from '@lenne.tech/nest-server';
import { TusController } from './modules/tus/tus.controller';

@Module({
  imports: [
    // ... other imports
    TusModule.forRoot({
      controller: TusController, // Use custom controller
    }),
  ],
})
export class ServerModule {}
```

---

## Step 2: Custom Service (Custom Upload Handling)

**Create:** `src/server/modules/tus/tus.service.ts`

```typescript
import { Injectable } from '@nestjs/common';
import { CoreTusService } from '@lenne.tech/nest-server';
import { Upload } from '@tus/server';

@Injectable()
export class TusService extends CoreTusService {
  protected override async onUploadComplete(upload: Upload): Promise<void> {
    // Call parent to handle GridFS migration
    await super.onUploadComplete(upload);

    // Add custom logic
    const metadata = upload.metadata;
    console.log(`Upload complete: ${metadata.filename}`);
    // await this.notificationService.sendUploadComplete(...);
  }
}
```

**Note:** To use a custom service, you'll need to create a custom TusModule that provides your service instead of CoreTusService.

---

## Configuration Options

### Default Configuration (No Changes Needed)

```typescript
// TUS works with these defaults:
{
  enabled: true,
  path: '/tus',
  maxSize: 50 * 1024 * 1024 * 1024, // 50 GB
  expiration: { expiresIn: '24h' },
  roles: [RoleEnum.S_USER],         // since 11.33.0 (was S_EVERYONE)
  // s3Staging: true when `s3` is configured — stages in-progress uploads in
  // s3.stagingBucket instead of on pod-local disk, so resumable uploads survive
  // replica restarts and need no sticky sessions. Set false to force local disk.
}
```

### Custom Configuration

```typescript
// server.module.ts
TusModule.forRoot({
  config: {
    maxSize: 100 * 1024 * 1024, // 100 MB
    path: '/uploads',
    expiration: { expiresIn: '12h' },
  },
});
```

### Disable TUS

```typescript
TusModule.forRoot({ config: false });
```

---

## Verification Checklist

- [ ] `npm run build` succeeds
- [ ] `npm test` passes
- [ ] `OPTIONS /tus` returns TUS capabilities **without a token** (the CORS preflight must stay public)
- [ ] `POST /tus` **without** a token answers `401` (or `204` if you deliberately set `roles: [S_EVERYONE]`)
- [ ] Upload via tus-js-client works for a user holding a role from `tus.roles`
- [ ] File appears in the configured file store after upload completion (GridFS by default; S3 or filesystem per `file.storage`)
- [ ] The uploaded file can also be **downloaded** by its intended audience — check `file.downloadRoles` too

---

## Common Mistakes

| Mistake                                            | Symptom                                                   | Fix                                                                                             |
| -------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Assuming uploads are still public (pre-11.33.0)    | `401` on the very first `POST /tus` from a public form    | `tus: { roles: [RoleEnum.S_EVERYONE] }` — Step 0                                                |
| `tus: { roles: [] }` meaning "nobody"              | Warning in the log, default `[S_USER]` applied instead    | An empty role set would OPEN the routes; name the roles explicitly — Step 0                     |
| Gating `OPTIONS` in a custom controller            | Every browser upload fails before the first byte          | Leave `handleTusOptions*` on `@Roles(RoleEnum.S_EVERYONE)` — the preflight sends no credentials |
| Expecting a subclass `@Roles()` to win over config | Roles look ignored                                        | `applyRoles()` overwrites them — Step 1 table                                                   |
| Forgot to register custom controller               | Custom handler logic never runs (core controller is used) | Add `controller: TusController` to `forRoot()`                                                  |
| Upload succeeds but the file cannot be downloaded  | `403` on `GET /files/id/:id`                              | `file.downloadRoles` defaults to `[ADMIN]` — widen it, or authorize per file in `checkRights()` |
| Using wrong endpoint path                          | 404 on upload                                             | Ensure client uses same path as config                                                          |

---

## Client Configuration

```typescript
import { Upload } from 'tus-js-client';

const upload = new Upload(file, {
  endpoint: 'http://localhost:3000/tus',
  headers: {
    Authorization: `Bearer ${token}`, // If authentication required
  },
  metadata: {
    filename: file.name,
    filetype: file.type,
  },
  onSuccess: () => console.log('Upload complete!'),
});

upload.start();
```

---

## Detailed Documentation

- **README.md:** `node_modules/@lenne.tech/nest-server/src/core/modules/tus/README.md`
- **GitHub:** https://github.com/lenneTech/nest-server/blob/develop/src/core/modules/tus/README.md