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

By default, TUS allows everyone (`S_EVERYONE`) to upload. To require authentication, create a custom controller:

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

### Custom Upload Handler

Override `onUploadComplete` to customize what happens after upload:

```typescript
// src/server/modules/tus/tus.service.ts
import { Injectable } from '@nestjs/common';
import { CoreTusService } from '@lenne.tech/nest-server';
import { Upload } from '@tus/server';

@Injectable()
export class TusService extends CoreTusService {
  protected override async onUploadComplete(upload: Upload): Promise<void> {
    // Call parent to migrate to GridFS
    await super.onUploadComplete(upload);

    // Custom logic after upload
    const metadata = upload.metadata;
    await this.notificationService.sendUploadComplete(metadata.filename);
    await this.analyticsService.trackUpload(upload.id, upload.size);
  }
}
```

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
  file(id: "...") {
    id
    filename
    contentType
    length
  }
}
```

**Recommendation:** Use the ID-based endpoint (`/files/id/:id`) for TUS uploads as filenames may not be unique.

### File Metadata

The following metadata is stored with each GridFS file:

| Field              | Source                            |
| ------------------ | --------------------------------- |
| `filename`         | From TUS `Upload-Metadata` header |
| `contentType`      | From TUS `filetype` metadata      |
| `tusUploadId`      | Original TUS upload ID            |
| `originalMetadata` | All TUS metadata                  |
| `uploadedAt`       | Completion timestamp              |

---

## Troubleshooting

### Upload returns 503 "TUS uploads not available"

**Cause:** TUS server not initialized

**Solutions:**

1. Check if TUS is disabled in config (`tus: false`)
2. Verify MongoDB connection is established
3. Check server logs for initialization errors

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