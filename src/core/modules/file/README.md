# File Module

File upload and download functionality with MongoDB GridFS storage.

## Endpoints

### Download Endpoints (via CoreFileController)

| Method | Endpoint           | Description               | Gated by        |
| ------ | ------------------ | ------------------------- | --------------- |
| GET    | `/files/id/:id`    | Download file by ID       | `downloadRoles` |
| GET    | `/files/:filename` | Download file by filename | `downloadRoles` |

### GraphQL members (via CoreFileResolver)

| Member        | Kind     | Gated by        |
| ------------- | -------- | --------------- |
| `getFileInfo` | Query    | `downloadRoles` |
| `uploadFile`  | Mutation | `uploadRoles`   |
| `uploadFiles` | Mutation | `uploadRoles`   |
| `deleteFile`  | Mutation | `deleteRoles`   |

> `CoreFileResolver` is registered by no core module. It only takes effect in a project that
> registers it (or a subclass) itself — enabling GraphQL alone does not.

---

## Configuration

One `file` object configures the module — where the bytes live and who may reach them:

```typescript
file: {
  storage: 'gridfs',                 // 'filesystem' | 'gridfs' | 's3' — omit to derive it
  storageDir: 'uploads/files',       // only for 'filesystem'
  downloadRoles: [RoleEnum.ADMIN],   // GET /files/id/:id, GET /files/:filename, getFileInfo
  uploadRoles:   [RoleEnum.ADMIN],   // uploadFile, uploadFiles
  deleteRoles:   [RoleEnum.ADMIN],   // deleteFile
},
```

`storage` and the role knobs are orthogonal: one picks the driver, the others the access.

## Storage drivers

Three equivalent options. They differ only in where the bytes end up:

| Driver         | Bytes                     | Survives a restart       | Shared between replicas | Needs                              |
| -------------- | ------------------------- | ------------------------ | ----------------------- | ---------------------------------- |
| `'s3'`         | S3-compatible bucket      | yes                      | **yes**                 | `s3` config + `@aws-sdk/client-s3` |
| `'gridfs'`     | MongoDB GridFS            | yes                      | yes                     | nothing beyond the database        |
| `'filesystem'` | local disk (`storageDir`) | only on a mounted volume | **no**                  | nothing                            |

**Metadata always lives in the database**, whichever driver holds the bytes. Filename, content type,
length and the custom `metadata` a per-file rule reads have to be queryable — `findFileInfo()` filters
and pages over them, `checkRights()` reads them per request. A directory listing answers none of
that, and sidecar files would reinvent an index the database already is. So `'filesystem'` moves the
bytes off the database, not the bookkeeping.

### Choosing the driver

**Set it explicitly and it is enforced.** If the chosen store is not available, the boot **fails**:

```
file.storage is set to 's3', but that storage is not available.
Configure `s3` (bucket, credentials/endpoint) and install `@aws-sdk/client-s3`, …
```

That is deliberate. The previous behaviour fell back to GridFS whenever S3 was selected but
unusable — the application kept working, so nothing looked broken, while files landed in a store the
operator did not believe they were in. Afterwards nobody can tell which file went where.

**Leave it unset and it is derived**, most capable first:

1. `'s3'` — when `s3.bucket` is configured
2. `'gridfs'` — when a database is configured
3. `'filesystem'` — when neither is

A configured-but-**unreachable** database is an error in its own right (Mongoose fails the boot), never
a reason to fall through to the disk. Only a database that is not configured **at all** reaches step 3 —
which today is theoretical, since `CoreModule` always registers Mongoose.

A derived driver is enforced too: `s3.bucket` in the config makes S3 the default, but the bytes still
go nowhere unless your `FileService` forwards the services to `super()`:

```typescript
super(connection, 'fs', { configService, s3Service });
```

### Switching drivers is forward-only

Reads consult **every** store, so files written under a previous driver stay readable and there is no
migration step and no cut-over moment. New files go to the active driver; `findFileInfo()` returns
the union, paged once over the merged result.

The boot log names the driver in use, so it never has to be inferred from where files stopped
appearing:

```
[CoreFileStorage] File storage: s3 (defaulted — s3.bucket is configured)
```

---

## Access control

Two layers, and they answer different questions.

### 1. Roles — _may this caller reach the endpoint at all?_

All three role knobs take **plain role strings**, so your own project roles work exactly as they
would in a hand-written `@Roles()`.

All three default to `[ADMIN]`. That default is restrictive on purpose: the file store is a **single
bucket shared by every feature** of the project — GridFS or S3, whichever `file.storage` selects —
and the ids naming its blobs are not secrets. An id is an ObjectId (4-byte timestamp, 5-byte
per-process random, 3-byte counter), so one upload of your own discloses the per-process value in
full and bounds the counter, collapsing the id space to a brute-forceable range. `/files/:filename`
is weaker still: it resolves the **first** match for a name a caller may be able to guess.

Three properties worth knowing:

- **ADMIN always keeps access.** Handler and class roles are UNIONed (`mergeRolesMetadata`), and both
  classes carry a class-level `@Roles(ADMIN)`. So `downloadRoles: ['editor']` grants editors _in
  addition to_ admins. These knobs cannot exclude admins.
- **`[]` is rejected, not honoured.** An all-empty role set reads to the guards as "no roles
  required" and would OPEN the route. An empty array logs a warning and falls back to the default.
- **Roles are checked against `user.roles`, never `membership.role`.** Both classes carry
  `@SkipTenantCheck()`. No store is reached through Mongoose — GridFS goes through the native driver,
  the S3 and filesystem metadata live in their own `s3-files` / `filesystem-files` collections — so
  `mongooseTenantPlugin` never scopes them. None is tenant-scoped, and a role name alone therefore
  cannot express a per-tenant rule. Use layer 2 for that.

### 2. `checkRights()` — _may this caller have THIS file?_

Roles cannot express "…but only their own". That is what the service hook is for:

```typescript
export class FileService extends CoreFileService {
  protected override async checkRights(
    input: any,
    options?: FileServiceOptions & { checkInputType: FileInputCheckType },
  ): Promise<boolean> {
    if (options?.checkInputType !== 'id' || options.force) {
      return true;
    }
    if (options.currentUser?.hasRole([RoleEnum.ADMIN])) {
      return true;
    }
    const raw = await this.getRawFileInfo(input);
    return !!raw && String(raw.metadata?.ownerId) === String(options.currentUser?.id);
  }
}
```

Three pieces make this work, and all three are needed:

1. **Write the metadata at upload time** — `createFile(file, { metadata: { ownerId: user.id } })`.
   `CoreFileService.createFile()` passes `serviceOptions.metadata` straight to the storage driver,
   so it works for both GridFS and S3.
2. **Read it back with `getRawFileInfo()`** (or `getRawFileInfoByName()`), not `getFileInfo()`. The
   public getter runs `prepareOutput` → `check()`, which strips fields the caller may not see —
   including the very field the decision rests on. `getRawFileInfo()` consults every metadata store
   in the same order `getFileInfo()` uses, so a rule sees the file the download would actually
   serve — under any driver.
3. **`options.currentUser` is supplied by the core controller and resolver** for every member.

When `checkRights()` refuses, `getFileStream()` returns `null` and the controller answers **404** —
deliberately the same answer as an unknown id, so the endpoint cannot be used to probe which files
exist. Do not turn that into a 403 in an override without accepting that trade-off.

### Serving files to a browser `<img>` / `<a download>`

A markup-driven request cannot send an `Authorization` header, and a CORS preflight sends no
credentials at all. So anything stricter than `S_EVERYONE` only works from markup when the session
travels as a **cookie** on a same-site request.

If some files are genuinely public and others are not, the answer is not a role list — it is a
per-file rule. Record a visibility flag in the metadata at upload time and branch on it in
`checkRights()`, or expose a separate public route for exactly the files that are meant to be
public and leave these two gated.

**Presigned S3 downloads** (`file.storage: 's3'` with presigned downloads enabled) sidestep the
`<img>` problem, because the browser fetches the object directly from S3. Understand what you are
issuing, though: the URL is a **bearer capability** — anyone holding it can fetch the object until
it expires, with no session. Authorization happens once, when the URL is issued (through the
`getFileInfo()` call that precedes the redirect). Keep the expiry short, and do not enable it for
files whose audience is narrower than "anyone who was ever given the link".

### Overriding: read this before you re-declare a member

`CoreFileController` and `CoreFileResolver` are meant to be extended — but role metadata lives on
the **function object**, so an override carries its own and thereby **opts out of `file.*Roles`
entirely**. Two consequences that bite in practice:

```typescript
// WRONG — the route DISAPPEARS. Nest reads PATH_METADATA off the subclass
// function, which has none, so it is never registered: 404 for everyone,
// no error, no warning.
override async getFileById(@Param('id') id: string, @Res() res: Response) {
  return super.getFileById(id, res);
}

// WRONG — pins the policy and silently ignores `file.downloadRoles` forever.
// This exact shape kept generated projects public after the framework default
// had already been closed.
@Get('id/:id')
@Roles(RoleEnum.S_EVERYONE)
override async getFileById(@Param('id') id: string, @Res() res: Response) {
  return super.getFileById(id, res);
}

// RIGHT — don't override at all. Configure it:
//   file: { downloadRoles: [RoleEnum.S_USER] }
// and put per-file rules in checkRights().
```

A class-level `@Roles()` on your subclass cannot relax an inherited member either: the inherited
function carries its own handler-level roles, and the two are unioned rather than overridden.

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

File operations are also available via GraphQL through `CoreFileResolver` — in a project that
registers it. See [Access control](#access-control) for which knob gates which member.

```graphql
# Read file info by filename (downloadRoles)
query {
  getFileInfo(filename: "...") {
    id
    filename
    contentType
    length
  }
}

# Upload a file via the GraphQL Upload scalar (uploadRoles)
mutation {
  uploadFile(file: Upload!) {
    id
    filename
  }
}

# Upload several files (uploadRoles)
mutation {
  uploadFiles(files: [Upload!]!) {
    id
    filename
  }
}

# Delete by filename (deleteRoles)
mutation {
  deleteFile(filename: "...") {
    id
  }
}
```

> Earlier revisions of this file documented `file(id:)` and `fileByFilename(filename:)`. Neither has
> ever existed on `CoreFileResolver`; the query is `getFileInfo(filename:)`.

---

## Integration with TUS

Files uploaded via TUS land in the same GridFS bucket and are read back through the same endpoints —
which means the same `downloadRoles` gate applies:

```bash
# After the TUS upload completes, download by ID (requires downloadRoles)
GET /files/id/<gridfs-file-id>

# Or by filename, if unique (requires downloadRoles)
GET /files/<original-filename>
```

**Recommendation:** use ID-based downloads for TUS uploads, since filenames may not be unique.

**Watch the pairing.** TUS uploads are gated separately by `tus.roles` (default `S_USER`). The
common "user uploads their own file, then views it" flow therefore needs both sides to line up: a
signed-in user may upload, but with the default `downloadRoles: [ADMIN]` they cannot read the result
back. Either widen `downloadRoles`, or — better — write an owner into the metadata at upload time
and authorize per file in `checkRights()`. TUS uploads already carry `metadata.tusUploadId` and the
original TUS metadata, so there is a natural place to add one.

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