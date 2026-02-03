# TUS Integration Checklist

**For customizing TUS uploads in projects using `@lenne.tech/nest-server`.**

> **Note:** TUS is **enabled by default** with no configuration needed. This checklist is only for projects that need to customize behavior (e.g., require authentication).

---

## Do You Need This Checklist?

| Scenario                                     | Checklist Needed?                                    |
| -------------------------------------------- | ---------------------------------------------------- |
| Use TUS with defaults (everyone can upload)  | No - works automatically                             |
| Require authentication for uploads           | Yes - Step 1                                         |
| Custom upload handling (notifications, etc.) | Yes - Step 2                                         |
| Disable TUS completely                       | No - just use `TusModule.forRoot({ config: false })` |

---

## Reference Implementation

**Local (in your node_modules):**

```
node_modules/@lenne.tech/nest-server/src/server/server.module.ts
```

**GitHub:**
https://github.com/lenneTech/nest-server/tree/develop/src/server

---

## Step 1: Custom Controller (Require Authentication)

**Create:** `src/server/modules/tus/tus.controller.ts`

```typescript
import { Controller } from '@nestjs/common';
import { CoreTusController, Roles, RoleEnum } from '@lenne.tech/nest-server';

@Controller('tus')
@Roles(RoleEnum.S_USER) // Require authenticated user
export class TusController extends CoreTusController {
  // All methods inherit the S_USER requirement
  // Override methods here for custom logic
}
```

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
- [ ] `OPTIONS /tus` returns TUS capabilities
- [ ] Upload via tus-js-client works
- [ ] File appears in GridFS after upload completion
- [ ] (If customized) Authentication is required for uploads

---

## Common Mistakes

| Mistake                              | Symptom                        | Fix                                               |
| ------------------------------------ | ------------------------------ | ------------------------------------------------- |
| Forgot to register custom controller | Default S_EVERYONE permissions | Add `controller: TusController` to forRoot()      |
| Custom controller missing @Roles     | No authentication required     | Add `@Roles(RoleEnum.S_USER)` to controller class |
| Using wrong endpoint path            | 404 on upload                  | Ensure client uses same path as config            |

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