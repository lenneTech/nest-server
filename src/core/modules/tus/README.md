# TUS Module

Integration of the [tus.io](https://tus.io) resumable upload protocol with @lenne.tech/nest-server via [@tus/server](https://github.com/tus/tus-node-server).

## TL;DR

```typescript
// TUS is ENABLED BY DEFAULT - no configuration needed!
// Just update to the latest @lenne.tech/nest-server version

// To customize:
TusModule.forRoot({
  config: {
    maxSize: 100 * 1024 * 1024, // 100 MB instead of 50 GB default
    path: '/uploads', // Custom path instead of /tus
  },
});

// To disable:
TusModule.forRoot({ config: false });
```

**Quick Links:** [Integration Checklist](./INTEGRATION-CHECKLIST.md) | [Endpoints](#endpoints) | [Configuration](#configuration) | [Client Usage](#client-usage)

---

## Table of Contents

- [Features](#features)
- [Default Behavior](#default-behavior)
- [Endpoints](#endpoints)
- [Configuration](#configuration)
- [Client Usage](#client-usage)
- [Customization](#customization)
- [Integration with FileModule](#integration-with-filemodule)
- [Troubleshooting](#troubleshooting)

---

## Features

- **Resumable Uploads** - Upload large files with automatic resume on connection loss
- **Enabled by Default** - Works out of the box without configuration
- **GridFS Integration** - Completed uploads are automatically migrated to GridFS
- **Module Inheritance Pattern** - Customize permissions via controller extension
- **All TUS Extensions** - Creation, termination, expiration, checksum, concatenation

### TUS Protocol Extensions (All Enabled by Default)

| Extension                | Description                       |
| ------------------------ | --------------------------------- |
| **creation**             | Create new uploads via POST       |
| **creation-with-upload** | Include data in creation request  |
| **termination**          | Delete incomplete uploads         |
| **expiration**           | Auto-cleanup of abandoned uploads |
| **checksum**             | Verify data integrity             |
| **concatenation**        | Combine multiple uploads          |

---

## Default Behavior

TUS is **enabled by default** with the following configuration:

```typescript
{
  enabled: true,
  path: '/tus',
  maxSize: 50 * 1024 * 1024 * 1024, // 50 GB
  allowedTypes: undefined,          // All types allowed
  allowedHeaders: [],               // Additional custom headers (TUS headers already included)
  uploadDir: 'uploads/tus',
  creation: true,
  creationWithUpload: true,
  termination: true,
  expiration: { enabled: true, expiresIn: '24h' },
  checksum: true,
  concatenation: true,
}
```

**No configuration required** - TUS works immediately after updating @lenne.tech/nest-server.

---

## Endpoints

All endpoints are handled by the TUS protocol via `@tus/server`:

| Method  | Endpoint   | Description              |
| ------- | ---------- | ------------------------ |
| OPTIONS | `/tus`     | Get server capabilities  |
| POST    | `/tus`     | Create new upload        |
| HEAD    | `/tus/:id` | Get upload status/offset |
| PATCH   | `/tus/:id` | Continue upload          |
| DELETE  | `/tus/:id` | Terminate upload         |

### CORS Headers

The TUS server automatically handles CORS headers for browser-based clients:

- `Tus-Resumable`
- `Tus-Version`
- `Tus-Extension`
- `Tus-Max-Size`
- `Upload-Length`
- `Upload-Offset`
- `Upload-Metadata`

**`Access-Control-Allow-Origin` follows the API's CORS configuration (11.42.1+).** The tus handler
writes its responses itself, and without `allowedOrigins` `@tus/server` answers `*`. With cookie
authentication and separate app and API origins the request is credentialed, and every browser
refuses `*` there — uploads failed in the browser although the server answered 201. The origins now
come from `buildCorsConfig()` (`appUrl`, `baseUrl`, `cors.allowedOrigins`, `cors.allowAll`), the same
decision REST, GraphQL and Better-Auth make; `tus.allowedOrigins` overrides. Without credentialed CORS
(cookies off, or no origin resolvable) the tus default `*` stays.

The preflight (`OPTIONS`) is answered by Nest's CORS layer and was never affected — test an
**authenticated** request with an `Origin` header when checking this.

---

## Configuration

### Disable TUS

```typescript
// In server.module.ts
TusModule.forRoot({ config: false });

// Or via environment config
tus: false;
```

### Custom Configuration

```typescript
TusModule.forRoot({
  config: {
    // Custom endpoint path
    path: '/uploads',

    // Limit file size (default: 50 GB)
    maxSize: 100 * 1024 * 1024, // 100 MB

    // Restrict allowed file types
    allowedTypes: ['image/jpeg', 'image/png', 'application/pdf'],

    // Custom upload directory for temporary files
    uploadDir: 'temp/uploads',

    // Disable specific extensions
    termination: false,
    concatenation: false,

    // Custom expiration
    expiration: {
      enabled: true,
      expiresIn: '12h', // Cleanup after 12 hours
    },
  },
});
```

### Configuration Options

| Option               | Type              | Default                | Description                                              |
| -------------------- | ----------------- | ---------------------- | -------------------------------------------------------- |
| `enabled`            | boolean           | `true`                 | Enable/disable TUS                                       |
| `path`               | string            | `/tus`                 | Endpoint path                                            |
| `maxSize`            | number            | 50 GB                  | Maximum file size in bytes                               |
| `allowedTypes`       | string[]          | undefined              | Allowed MIME types (all if undefined)                    |
| `allowedHeaders`     | string[]          | `[]`                   | Additional custom headers (TUS headers already included) |
| `uploadDir`          | string            | `uploads/tus`          | Temporary upload directory                               |
| `creation`           | boolean           | `true`                 | Enable creation extension                                |
| `creationWithUpload` | boolean           | `true`                 | Enable creation-with-upload extension                    |
| `termination`        | boolean           | `true`                 | Enable termination extension                             |
| `expiration`         | boolean \| object | `{ expiresIn: '24h' }` | Expiration configuration                                 |
| `checksum`           | boolean           | `true`                 | Enable checksum extension                                |
| `concatenation`      | boolean           | `true`                 | Enable concatenation extension                           |

**Note on `allowedHeaders`:**

`@tus/server` already includes all TUS protocol headers by default:

- Authorization, Content-Type, Location, Tus-Extension, Tus-Max-Size
- Tus-Resumable, Tus-Version, Upload-Concat, Upload-Defer-Length
- Upload-Length, Upload-Metadata, Upload-Offset, X-HTTP-Method-Override
- X-Requested-With, X-Forwarded-Host, X-Forwarded-Proto, Forwarded

The `allowedHeaders` option is only for **project-specific custom headers**.

### Expiration Configuration

```typescript
// Boolean shorthand
expiration: true  // Enabled with 24h default
expiration: false // Disabled

// Object configuration
expiration: {
  enabled: true,
  expiresIn: '12h', // Supports: '24h', '1d', '30m', '3600s'
}
```

---

## Client Usage

### Using tus-js-client

```typescript
import { Upload } from 'tus-js-client';

const file = document.querySelector('input[type=file]').files[0];

const upload = new Upload(file, {
  endpoint: 'http://localhost:3000/tus',
  retryDelays: [0, 3000, 5000, 10000, 20000],
  metadata: {
    filename: file.name,
    filetype: file.type,
  },
  onError: (error) => {
    console.log('Upload failed:', error);
  },
  onProgress: (bytesUploaded, bytesTotal) => {
    const percentage = ((bytesUploaded / bytesTotal) * 100).toFixed(2);
    console.log(`${percentage}%`);
  },
  onSuccess: () => {
    console.log('Upload complete!');
    console.log('File URL:', upload.url);
  },
});

// Start or resume upload
upload.start();
```

### With Authentication

```typescript
const upload = new Upload(file, {
  endpoint: 'http://localhost:3000/tus',
  headers: {
    Authorization: `Bearer ${token}`,
  },
  // ... other options
});
```

### Resume Interrupted Upload

```typescript
// Store upload URL for resumption
localStorage.setItem('uploadUrl', upload.url);

// Later, resume with stored URL
const upload = new Upload(file, {
  endpoint: 'http://localhost:3000/tus',
  uploadUrl: localStorage.getItem('uploadUrl'),
  // ... other options
});

upload.start(); // Resumes from where it left off
```

---

## Customization

### Require Authentication

Since 11.33.0 TUS requires a signed-in caller by default (`tus.roles`, default `[S_USER]`). The
previous default was `S_EVERYONE`, which let anonymous callers write into — and, with the
termination extension, delete from — the same GridFS bucket the download routes guard.

Set it in `config.env.ts`:

```typescript
tus: {
  roles: [RoleEnum.S_USER];
} // default
tus: {
  roles: [RoleEnum.S_EVERYONE];
} // opt back in to anonymous uploads
tus: {
  roles: ['editor', 'contributor'];
} // project-specific roles work too
```

`roles: []` is rejected with a warning rather than honoured — an all-empty role set reads to the
guards as "no roles required" and would open the endpoints instead of closing them.

`OPTIONS` stays public regardless: it is the CORS preflight, which browsers send without
credentials, and it discloses only server capabilities.

Alternatively, create a custom controller:

```typescript
// src/server/modules/tus/tus.controller.ts
import { Controller } from '@nestjs/common';
import { CoreTusController, Roles, RoleEnum } from '@lenne.tech/nest-server';

@Controller('tus')
@Roles(RoleEnum.S_USER) // Require authenticated user
export class TusController extends CoreTusController {
  // All methods inherit S_USER requirement
}
```

Then register with custom controller:

```typescript
// server.module.ts
TusModule.forRoot({
  controller: TusController,
});
```

### Custom Service (11.41.9+)

Register a subclass of `CoreTusService` through `TusModule.forRoot({ service })`. Before 11.41.9
both provider factories constructed `CoreTusService` directly, so a subclass could not be plugged in
at all.

```typescript
// server.module.ts
TusModule.forRoot({ controller: TusController, service: TusService });
```

The module constructs the service itself, with exactly `(connection, options)` — keep that
constructor signature, and do not declare constructor dependencies of your own. Reach project
providers at call time through `this.options?.moduleRef` instead:

```typescript
const quota = this.options?.moduleRef?.get(QuotaService, { strict: false });
```

### Validate an Upload Before It Starts

`onUploadCreate(req, upload)` runs once per upload, after the client declared `Upload-Length` and
before a single byte is written — the only point at which a quota can refuse an upload without the
store having grown first. Throw an `Error` carrying `status_code` to refuse:

```typescript
import { CoreTusService } from '@lenne.tech/nest-server';
import { Upload } from '@tus/server';

export class TusService extends CoreTusService {
  protected override async onUploadCreate(req: any, upload: Upload) {
    const quota = this.options?.moduleRef?.get(QuotaService, { strict: false });
    if (!(await quota?.hasRoomFor(req, upload.size))) {
      const error = new Error('Storage quota exceeded');
      (error as any).status_code = 413;
      throw error;
    }
    return super.onUploadCreate(req, upload);
  }
}
```

Always return `super.onUploadCreate()`: it records the owner and the tenant and enforces
`allowedTypes`. Skipping it leaves the upload owner-less (reachable by every caller who may use TUS)
and lets any file type through.

### Custom Upload Handler

Override `onUploadComplete` to customize what happens after upload:

```typescript
// src/server/modules/tus/tus.service.ts
import { CoreTusService } from '@lenne.tech/nest-server';
import { Upload } from '@tus/server';

export class TusService extends CoreTusService {
  protected override async onUploadComplete(upload: Upload): Promise<void> {
    // Call parent to migrate to the configured file storage
    await super.onUploadComplete(upload);

    // Custom logic after upload
    const notifications = this.options?.moduleRef?.get(NotificationService, { strict: false });
    await notifications?.sendUploadComplete(upload.metadata?.filename);
  }
}
```

### Tenant Scoping (11.41.9+)

**Only with `multiTenancy` configured.** Without it nothing changes: no header is read, no field is
written.

With multi-tenancy active, an upload carrying the tenant header (`multiTenancy.headerName`, default
`x-tenant-id`) is validated against the caller's active memberships — the same check GraphQL
subscriptions use. The TUS routes carry `@SkipTenantCheck()`, so the tenant guard does not do this
for them.

| Request                                              | Result                                     |
| ---------------------------------------------------- | ------------------------------------------ |
| No tenant header                                     | upload stays tenant-less, as before        |
| Header naming a tenant the caller belongs to         | the finished file gets `metadata.tenantId` |
| Header naming a tenant the caller does NOT belong to | **403**, nothing is stored                 |

**The header has to come from the TUS client itself.** Projects usually add `X-Tenant-Id` in an
interceptor of their generated API client, and `tus-js-client` does not go through that client. Without
an explicit header the upload is accepted, stays tenant-less and bypasses tenant filtering and any
per-tenant quota, with no error anywhere. Pass it to the upload, e.g. with nuxt-extensions:

```typescript
const { addFiles } = useLtTusUpload({ headers: { 'X-Tenant-Id': currentTenantId } });
```

The tenant is recorded under `TUS_TENANT_METADATA_KEY` (`ltTenantId`), next to the owner under
`TUS_OWNER_METADATA_KEY`. Both keys are framework-owned and always overwritten, so a client cannot
put either of them into its own `Upload-Metadata`. `metadata.tenantId` on the finished file is what
the file module's `'tenant'` access preset and any per-file `checkRights()` rule read.

---

## Integration with FileModule

After a TUS upload completes, the file is automatically:

1. **Migrated to GridFS** - The temporary file is uploaded to MongoDB GridFS
2. **Metadata preserved** - Filename, content type, and TUS metadata are stored
3. **Temporary file deleted** - The local temporary file is removed

### Accessing Uploaded Files

Use the existing FileModule to access uploaded files:

```bash
# Via REST - by ID (recommended for TUS uploads)
GET /files/id/:id

# Via REST - by filename
GET /files/:filename

# Via GraphQL
query {
  getFileInfo(filename: "...") {
    id
    filename
    contentType
    length
  }
}
```

**Recommendation:** Use the ID-based endpoint (`/files/id/:id`) for TUS uploads as filenames may not be unique.

> **These download routes are gated.** They require `file.downloadRoles`, which defaults to
> `[RoleEnum.ADMIN]` — while uploading here only requires `tus.roles` (default `S_USER`). So out of
> the box a signed-in user can upload but cannot read their own file back.
>
> Do not fix that by widening `downloadRoles` to `S_USER`: that would let every signed-in user read
> _every_ file in the shared bucket. Write an owner into the file metadata at upload time and
> authorize per file in `CoreFileService.checkRights()` — see the File module's README, section
> "Access control".

### File Metadata

The following metadata is stored with each GridFS file:

| Field              | Source                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `filename`         | From TUS `Upload-Metadata` header                                                                       |
| `contentType`      | From TUS `filetype` metadata                                                                            |
| `tusUploadId`      | Original TUS upload ID                                                                                  |
| `originalMetadata` | All TUS metadata                                                                                        |
| `ownerId`          | The authenticated uploader (11.35.0+)                                                                   |
| `tenantId`         | The validated tenant, only with `multiTenancy` (11.41.9+) — see [Tenant Scoping](#tenant-scoping-11419) |
| `uploadedAt`       | Completion timestamp                                                                                    |

### Upload ownership (11.35.0+)

`tus.roles` decides **who may reach the endpoint**. It says nothing about **which upload** a caller may
touch — and the protocol is built around a per-upload URL: after `POST /tus` the client holds
`/tus/<id>` and uses it for `HEAD` (offset), `PATCH` (append bytes) and `DELETE` (terminate). Until
11.35.0 all three carried only that coarse gate, so any other authenticated caller who learned an id
could resume, **overwrite** or destroy somebody else's upload. Overwriting is the sharp end: the bytes
are migrated into the file store under the ORIGINAL uploader's filename.

Two things changed:

- **`onUploadCreate` records the creator** in the upload's own metadata under
  `TUS_OWNER_METADATA_KEY` (`ltOwnerId`). It **overwrites** any client-supplied value — metadata
  arrives in the `Upload-Metadata` header, so a merged value would let a caller name somebody else as
  the owner.
- **`onIncomingRequest` refuses a request naming an upload the caller does not own**, with **404** — the
  same "a refusal is indistinguishable from a missing resource" policy the file module uses, so the
  endpoint is not an existence oracle for upload ids.

The finished file's metadata gains `ownerId`, which is the key
`CoreFileService.checkRights()` documents — so a tus-uploaded file can finally satisfy a per-file
ownership rule. Before this it could not: the rule failed closed for everyone but ADMIN, and a project
following the documented pattern ended up with files nobody could download.

**An owner-LESS upload stays reachable by anyone who may reach the endpoint.** Deliberately: uploads
created before 11.35.0 carry no owner, and neither does an intentionally public form
(`tus.roles: [RoleEnum.S_EVERYONE]`). Denying those would break in-flight uploads on upgrade and a
documented configuration. What is closed is an upload that HAS an owner being touched by somebody else.

Both `readRequestUserId()` and `assertUploadOwnership()` are `protected` — override to read the owner
from elsewhere (an API key, a signed form token), or to let a support role resume any upload.

> **Note for a custom service:** `@tus/server` v2 does NOT hand the Express request to its hooks. It
> converts the Node request into a WHATWG `ServerRequest` first, so anything a guard attached lives on
> the original request, reachable through `runtime.node.req` — which is why `readRequestUserId()` checks
> there as well. Reading only `req.user` finds nothing and every upload silently becomes owner-less,
> failing in the permissive direction.

---

## Troubleshooting

### Upload returns 503 "TUS uploads not available"

**Cause:** TUS server not initialized

**Solutions:**

1. Check if TUS is disabled in config (`tus: false`)
2. Verify MongoDB connection is established
3. Check server logs for initialization errors

### Upload is stored but the client never sees success (fixed in 11.42.2)

**Symptom:** the file appears in the file store (`Upload … migrated to …` in the log), but the final
`PATCH` never answers (the request hangs: the headers are already sent, so no error response can
follow), `tus-js-client` never fires `onSuccess`, and the log shows
`ERR_INVALID_ARG_TYPE … Received function`.

**Cause:** `@tus/server` finishes its responses with `res.end(callback)`, and the `compression`
middleware patches `res.end(chunk, encoding)` and reads the callback as a chunk. The starter registers
`compression` with `filter: () => true` and `threshold: 0`, so it also handles the bodyless 204.

**Solution:** update to 11.42.2 — `CoreTusService` normalises `res.end(callback)` before the tus
server writes (`normalizeEndCallback()`), for the core controller and any project controller that
calls `getServer().handle()`. No change to `main.ts` is needed.

### Upload stalls or fails to resume

**Cause:** Upload expired or server restarted

**Solutions:**

1. Check expiration configuration (default: 24h)
2. Increase `expiration.expiresIn` if needed
3. Client should handle `onError` and create new upload

### CORS errors in browser

**Cause:** Missing or incorrect CORS configuration

**Solutions:**

1. Verify client sends correct headers
2. Check that `Tus-Resumable` header is included
3. Ensure server CORS allows TUS headers

### File not appearing in GridFS after upload

**Cause:** Upload incomplete or migration failed

**Solutions:**

1. Verify upload completed (check `onSuccess` callback)
2. Check server logs for migration errors
3. Verify MongoDB GridFS bucket exists (`fs.files`, `fs.chunks`)

### Large uploads failing

**Cause:** File exceeds `maxSize` limit

**Solutions:**

1. Increase `maxSize` in configuration
2. Check for proxy/nginx upload limits
3. Verify client `chunkSize` is reasonable

---

## Technical Details

### Dependencies

- `@tus/server` ^2.3.0 - TUS protocol server implementation
- `@tus/file-store` ^2.0.0 - File system storage for uploads

### Upload Flow

```
1. Client: POST /tus (create upload)
2. Server: Returns Upload-Location header
3. Client: PATCH /tus/:id (send chunks)
4. Server: Returns Upload-Offset
5. Client: Repeat PATCH until complete
6. Server: Migrate to GridFS, cleanup temp file
```

### File Storage

- **During upload:** Files stored in `uploadDir` (default: `uploads/tus`)
- **After completion:** Files migrated to MongoDB GridFS
- **Expiration:** Incomplete uploads cleaned up after `expiresIn` (default: 24h)

---

## Related Documentation

- [tus.io Protocol](https://tus.io/protocols/resumable-upload)
- [tus-js-client](https://github.com/tus/tus-js-client)
- [@tus/server](https://github.com/tus/tus-node-server)
- [FileModule Documentation](../file/README.md)