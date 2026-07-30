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

Access can also be restricted per file by overriding `CoreFileService.checkRights()`. When it
refuses, `getFileStream()` returns `null` and the controller answers **404** — deliberately the same
answer as an unknown id, so the endpoint cannot be used to probe which files exist. Do not change
this to a 403 in an override without accepting that trade-off.

### Error responses

| Situation                                                                              | Status | Body                                                                                                  |
| -------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------- |
| Unknown id / filename, or `checkRights()` refused                                      | `404`  | `NotFoundException` with `ErrorCode.FILE_NOT_FOUND`                                                   |
| Missing id / filename in the route                                                     | `400`  | `BadRequestException` with `ErrorCode.REQUIRED_FIELD_MISSING`                                         |
| GridFS read fails **before** any byte was sent (file document exists, chunks are gone) | `404`  | `{ "error": "Not Found", "message": "<FILE_NOT_FOUND>", "statusCode": 404 }`                          |
| GridFS read fails **after** streaming started                                          | —      | The connection is closed; a truncated transfer is the only signal left once the status is on the wire |

The mid-stream failure case is handled by `pipeFileToResponse()`. Without it the stream error would
go unhandled, Node would destroy the socket, and a reverse proxy would report **502 Bad Gateway** —
i.e. "the server is down", while every other route keeps answering. On the error path the headers
describing the file (`Content-Type`, `Content-Disposition`, `Cache-Control`, `ETag`) are removed, so
the JSON body is not labelled as the image it failed to deliver. The error itself is logged
server-side even though the client answer stays deliberately generic.

To change the status, the body or the logging, override the `protected pipeFileToResponse()` method
on the controller rather than the exported function of the same name.

### Upload filtering

Upload endpoints are project-specific, but the filter they install comes from the framework
(`multerOptionsForImageUpload()` / `multerFileFilter()` in `common/helpers/file.helper.ts`). Name what
the endpoint accepts as an `UploadAllowList` — both the mimetype and the extension are compared as
WHOLE values:

```typescript
@UseInterceptors(FileInterceptor('file', multerOptionsForImageUpload({
  allowList: {
    extensions: ['.jpeg', '.jpg', '.pdf', '.png'],
    mimeTypes: ['application/pdf', 'image/jpeg', 'image/png'],
  },
})))
```

The two conditions are **independent**: either one alone rejects the file, while a pair that is odd
yet individually allowed (`report.txt` announced as `application/pdf`) passes. An extension→mimetype
MAPPING is deliberately not enforced, because user agents genuinely disagree about office and audio
types (macOS reports `.csv` as `text/plain`) and a mapping would reject legitimate uploads.

The legacy `fileTypeRegex` option still works and keeps precedence, but is **deprecated**: one
expression is `.test()`ed against both the mimetype and the extension, so every alternative matches
as a SUBSTRING — an allow-list containing `te?xt` also accepts `text/html`.

Types a browser may execute as script (`text/html`, `image/svg+xml`, `application/xhtml+xml`, XML and
JavaScript types, plus the matching extensions) are rejected **before** the allow-list is consulted,
on both forms. A stored upload served back from the API origin with one of these content types runs
in that origin, with the victim's session. Opt out only when the file never reaches an origin that
carries a session:

```typescript
multerFileFilter({ extensions: ['.svg'], mimeTypes: ['image/svg+xml'] }, { allowScriptableTypes: true });
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