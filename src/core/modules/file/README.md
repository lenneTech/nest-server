# File Module

File upload and download functionality with MongoDB GridFS storage.

## Endpoints

### Public Endpoints (via CoreFileController)

| Method | Endpoint           | Description               |
| ------ | ------------------ | ------------------------- |
| GET    | `/files/id/:id`    | Download file by ID       |
| GET    | `/files/:filename` | Download file by filename |

**Note:** These endpoints are public (`S_EVERYONE`) by default. Projects can restrict access by extending `CoreFileController`.

### Admin Endpoints (project-specific)

Projects typically add admin-only endpoints like:

| Method | Endpoint          | Description                       |
| ------ | ----------------- | --------------------------------- |
| POST   | `/files/upload`   | Upload file (multipart/form-data) |
| GET    | `/files/info/:id` | Get file metadata                 |
| DELETE | `/files/:id`      | Delete file                       |

---

## Usage in Projects

### Basic Setup (Extend CoreFileController)

```typescript
// src/server/modules/file/file.controller.ts
import { Controller } from '@nestjs/common';
import { CoreFileController, Roles, RoleEnum } from '@lenne.tech/nest-server';
import { FileService } from './file.service';

@Controller('files')
@Roles(RoleEnum.ADMIN)
export class FileController extends CoreFileController {
  constructor(protected override readonly fileService: FileService) {
    super(fileService);
  }

  // Add admin-only endpoints here (upload, delete, etc.)
}
```

### Restrict Download Access

To require authentication for downloads, override the inherited methods:

```typescript
@Controller('files')
@Roles(RoleEnum.ADMIN)
export class FileController extends CoreFileController {
  constructor(protected override readonly fileService: FileService) {
    super(fileService);
  }

  // Override to require authentication for ID-based download
  @Get('id/:id')
  @Roles(RoleEnum.S_USER) // Require logged-in user
  override async getFileById(@Param('id') id: string, @Res() res: Response) {
    return super.getFileById(id, res);
  }

  // Override to require authentication for filename-based download
  @Get(':filename')
  @Roles(RoleEnum.S_USER)
  override async getFile(@Param('filename') filename: string, @Res() res: Response) {
    return super.getFile(filename, res);
  }
}
```

---

## GraphQL Support

File operations are also available via GraphQL through `CoreFileResolver`:

```graphql
# Query file by ID
query {
  file(id: "...") {
    id
    filename
    contentType
    length
  }
}

# Query file by filename
query {
  fileByFilename(filename: "...") {
    id
    filename
    contentType
  }
}

# Upload file (via GraphQL Upload scalar)
mutation {
  uploadFile(file: Upload!) {
    id
    filename
  }
}

# Delete file
mutation {
  deleteFile(filename: "...") {
    id
  }
}
```

---

## Integration with TUS

Files uploaded via TUS are automatically stored in GridFS and can be accessed through the same endpoints:

```bash
# After TUS upload completes, download by ID
GET /files/id/<gridfs-file-id>

# Or by filename (if unique)
GET /files/<original-filename>
```

**Recommendation:** Use ID-based downloads for TUS uploads as filenames may not be unique.

---

## GridFS Storage

Files are stored in MongoDB GridFS with the following structure:

**fs.files collection:**

```json
{
  "_id": ObjectId,
  "filename": "example.pdf",
  "length": 1048576,
  "uploadDate": ISODate,
  "metadata": {
    "contentType": "application/pdf",
    "tusUploadId": "...",  // If uploaded via TUS
    "uploadedAt": ISODate
  }
}
```

**fs.chunks collection:**

- Binary file data split into 255KB chunks
- Automatically managed by GridFS

---

## Related Documentation

- [TUS Module](../tus/README.md) - Resumable upload protocol
- [CoreFileService](./core-file.service.ts) - File service implementation