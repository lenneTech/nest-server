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

That holds per method and in **both** directions — adopting a driver and switching away from one.
The metadata lookups are gated on whether a store is USABLE, never on whether it is the active write
driver, so pinning `file.storage: 'gridfs'` on a deployment that once used S3 keeps the S3 files
readable rather than 404-ing them.

Three consequences worth knowing about the merged read path:

- **Ordering.** Each store answers its own correctly ordered page, and the merge re-establishes a
  global order before it pages (`sortMergedFileInfo()`), including dotted sort fields such as
  `metadata.ownerId`. Without a `sort` the merged page is `uploadDate` descending.
- **`contentType`.** GridFS keeps it inside `metadata`, the other two stores at the document root.
  `GridFSHelper.findFiles()` rewrites the key so a filter or sort on `contentType` behaves the same
  under every driver.
- **Duplication crosses drivers.** `duplicateByName()` / `duplicateById()` read the source from
  whichever store holds it and write the copy to the ACTIVE driver, so duplicating a file that is
  still in GridFS while `file.storage: 's3'` simply moves it forward.

`s3-files` and `filesystem-files` are created on their first WRITE, never on a read — a deployment
that only ever uses GridFS never grows them.

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
    // Writes, list queries and forced (system) calls stay on the coarse role gate
    if (options?.force || (options?.checkInputType !== 'filename' && options?.checkInputType !== 'id')) {
      return true;
    }
    if (options.currentUser?.hasRole?.([RoleEnum.ADMIN])) {
      return true;
    }
    const raw =
      options.checkInputType === 'id' ? await this.getRawFileInfo(input) : await this.getRawFileInfoByName(input);
    // Fails closed without a user, and on a file that records no owner.
    return !!raw?.metadata?.ownerId && String(raw.metadata.ownerId) === String(options.currentUser?.id);
  }
}
```

This is not a sketch: it is the rule `src/server/modules/file/file.service.ts` runs, with
`file: { downloadRoles: [RoleEnum.S_USER] }` in `src/config.env.ts` so the coarse gate actually
lets it fire. It used to live here and in that file as a **comment**, on the reasoning that the
`[ADMIN]` default made it unreachable in the reference server anyway — and a commented rule is never
compiled, never type-checked and never run. That is how a `deleteFileByName()` regression on the
`filename` branch shipped through a full green suite.

**Cover the `filename` branch too, not just `id`.** An id-only rule is enough while bytes are
streamed, because the filename route resolves an id and checks it again — but not once
`file.storage: 's3'` with presigned downloads is enabled, where the filename route authorizes on the
by-name lookup alone and then redirects, and not for `deleteFileByName()`, which authorizes by name
only.

**A reused filename resolves to the MOST RECENT file (11.35.0+).** Filenames are unique in no store
and are client-supplied on both the multer and the tus path, so a by-name lookup is inherently
ambiguous — prefer the id routes. What must NOT be ambiguous is which of the candidates each by-name
path picks. Until 11.35.0 the GridFS driver got that wrong in the worst possible way:
`bucket.find({ filename })` answered natural order (the oldest document) while
`openDownloadStreamByName()` defaults to `revision: -1` (the newest), so `getFileInfoByName()` /
`getRawFileInfoByName()` authorized against one document and `getFileStreamByName()` /
`getBufferByName()` / `duplicateByName()` served another. An ownership rule approved the caller's own
file and handed over somebody else's bytes — across tenants, since the file stores carry no tenant
scope. All three drivers now resolve the most recent file (`uploadDate` desc, `_id` as tie-break) and
every by-name read path resolves a document and then reads **by id**.

One consequence worth knowing: `duplicateById()` keeps the source's filename and the copy carries no
`metadata` by design, so the copy WINS the name and an ownership rule keyed on `metadata.ownerId`
refuses it. Give the copy its own metadata or its own name.

### Before you write a rule: `file.access` may already be it

The four common project shapes are presets, so the rule below is only needed for the fifth — a project
whose rights the framework cannot guess.

| `file.access`        | project class                                          | own `checkRights()`? |
| -------------------- | ------------------------------------------------------ | -------------------- |
| `'public'`           | open: anyone may read and write                        | no                   |
| `'authenticated'`    | login-restricted: every signed-in user                 | no                   |
| `'owner'`            | per-user: only the uploader (plus ADMIN)               | no                   |
| `'tenant'`           | per-tenant: only the own validated tenant (plus ADMIN) | no                   |
| `'custom'` (default) | anything else — you write the rule                     | yes                  |

`'owner'` and `'tenant'` read `metadata.ownerId` / `metadata.tenantId` and `CoreFileService` **stamps
them as it writes** while the preset is active, so an upload through the service is authorizable without
project code. Files written before you enabled it carry no such metadata and stay ADMIN-only — the
fail-closed direction, fixable with a one-off backfill. Declaring the class never widens the role gate,
and it never overrides an explicit `checkRights()` override: the override IS the rule.

Everything the presets do is also the checklist for a hand-written rule, so read on either way.

**Cover the `filterArgs` branch, and REFUSE it.** `findFileInfo()` consults the hook once for the whole
query, so no answer can mean "…but only their own files". Returning `true` — which the reference rule
used to do — hands a caller a full inventory of every upload: `CoreFileInfo` carries `filename`,
`length`, `uploadDate` and the `id`, and for medical data the filename frequently IS the content. Core
exposes no listing endpoint, so this only bites once a project surfaces `findFileInfo()`.

A per-user listing is expressed by FORCING the constraint server-side:

```typescript
this.fileService.findFileInfo(
  {
    filter: {
      singleFilter: { field: 'metadata.ownerId', operator: ComparisonOperatorEnum.EQ, value: String(currentUser.id) },
    },
  },
  { force: true },
);
```

Note what that is NOT: it does not inspect the caller's own `filterArgs` to check whether they are
already narrowed. `filterArgs` is **client-controlled**, so approving a filter shape means validating
attacker input — and any such check is one filter shape away from being wrong. Override the filter;
never approve it.

**Never add `if (!options.currentUser) return true`.** It reads as "system-internal call, the guard
already decided" — but "no user in context" is also exactly what an **anonymous** request looks like.
While `downloadRoles` is narrower than `S_EVERYONE` the role gate turns those away first, so the
branch looks harmless; widen the gate, which this very section invites you to do, and it hands every
file to everyone. The ownership rule evaporates precisely when it starts to matter. The same reason
makes `!!raw?.metadata?.ownerId` load-bearing: without it, an owner-less file compares
`String(undefined)` against `String(undefined)` and matches.

Callers that really are internal should say so instead of relying on the omission — `{ force: true }`
where a role decorator already decided (an `@Roles(ADMIN)` admin endpoint), or the real
`{ currentUser }` where the user is in scope, so that call is **covered** by the ownership rule
rather than exempt from it. The reference server does both: `src/server/modules/file/` and
`src/server/modules/user/avatar.controller.ts`. The contract test for the whole rule, covering the
`id` **and** the `filename` branch, lives in `tests/file-ownership.e2e-spec.ts`.

**It covers duplication too (11.34.0+).** `duplicateByName()` / `duplicateById()` authorize a copy as
a READ of the source (`'filename'` / `'id'`) plus a WRITE of the copy (`'file'`), through the same
public methods every other caller uses — so forward the context:

```typescript
await this.fileService.duplicateById(id, { currentUser });
// …and give the COPY its own owner, because it does NOT inherit the source's metadata
await this.fileService.duplicateById(id, { currentUser, metadata: { ownerId: currentUser.id } });
```

Not copying the source's `metadata` is deliberate: doing so would silently hand the duplicate the
source's owner. A copy made without metadata is ADMIN-only under the rule above — fail-closed, not
lost.

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
`resolveFile()` call that precedes the redirect on `GET /files/id/:id`, and the
`getFileInfoByName()` call on `GET /files/:filename`; both run the same `checkRights()`). Keep the
expiry short, and do not enable it for files whose audience is narrower than "anyone who was ever
given the link".

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

> **Boot reports this, since 11.35.1 — but it only reports.** `CoreFileAccessAuditInitializer` reads
> the roles off the class you actually registered and warns when a member is open beyond platform
> admins for a reason the configuration cannot explain. So a subclass whose `getFileById()` carries
> `@Roles(RoleEnum.S_EVERYONE)` is now named at startup, with the member and the offending roles.
>
> It does **not** correct anything: your `@Roles()` still wins, because overwriting it would silently
> relax a route you may have pinned on purpose. **If you re-declare a download member, its `@Roles()`
> is your whole audience gate** — the warning tells you so, it does not close it for you. Inherit the
> member instead if you want `file.downloadRoles` to govern it.

### If you override `getFileInfo()`: `GET /files/id/:id` no longer calls it (11.33.0)

Up to 11.32.x, `GET /files/id/:id` called the public `CoreFileService.getFileInfo()` and then let
`getFileStream()` work out on its own which store held the bytes. With three stores to consult
(§ Storage drivers) that resolves the same id up to three times per download, so since 11.33.0 the
route calls **`resolveFile()`** instead, which answers the metadata and the store in one pass.

An override of `getFileInfo()` is therefore **no longer on that route's path**. It is still honoured
by every other caller it ever had — `deleteFile()`, `duplicateById()` and any project code that
calls it, such as the `GET /files/info/:id` endpoint projects usually add — which is exactly what
makes the gap easy to miss: the behaviour disappears on one route while everything else keeps it.
(The GraphQL `getFileInfo(filename:)` member resolves by NAME and has always gone through
`getFileInfoByName()`, so it is unaffected either way.)

This does **not** weaken authorization. `resolveFile()` runs the same `checkRights()` with the same
`serviceOptions`, and answers `null` on refusal, which the controller turns into the same 404. Only
work you added **on top** of the base `getFileInfo()` — a decorated field, a counter, a log line —
stops happening on the id route.

The remedy is to override `resolveFile()` as well, keeping the two consistent:

```typescript
export class FileService extends CoreFileService {
  override async getFileInfo(id: string | Types.ObjectId, serviceOptions?: FileServiceOptions) {
    return this.decorate(await super.getFileInfo(id, serviceOptions));
  }

  // Same treatment for the download route. `store` must be passed through
  // untouched — the controller hands it to getFileStream() to pick the store.
  override async resolveFile(id: string | Types.ObjectId, serviceOptions?: FileServiceOptions) {
    const resolved = await super.resolveFile(id, serviceOptions);
    return resolved && { ...resolved, info: this.decorate(resolved.info) };
  }
}
```

Per-file **authorization** needs none of this: it belongs in `checkRights()`, which both methods
call.

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

| Situation                                                                              | Status | Body                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unknown id / filename, or `checkRights()` refused                                      | `404`  | `NotFoundException` with `ErrorCode.FILE_NOT_FOUND`                                                                                                                                  |
| `deleteFile()` / `deleteFileByName()` / `duplicate*()` on a file that is not there     | `404`  | `NotFoundException`. Both halves of each id/name pair answer identically — up to 11.33.1 the by-id delete surfaced the driver's `MongoRuntimeError` as a `500`                       |
| Missing id / filename in the route                                                     | `400`  | `BadRequestException` with `ErrorCode.REQUIRED_FIELD_MISSING`                                                                                                                        |
| An upload's SOURCE stream fails (client aborts, staged read drops)                     | `500`  | The promise rejects with the cause — under **every** driver. It used to be an uncaught exception (i.e. a process exit) on GridFS, and on the S3 streaming path tus finalization uses |
| GridFS read fails **before** any byte was sent (file document exists, chunks are gone) | `404`  | `{ "error": "Not Found", "message": "<FILE_NOT_FOUND>", "statusCode": 404 }`                                                                                                         |
| GridFS read fails **after** streaming started                                          | —      | The connection is closed; a truncated transfer is the only signal left once the status is on the wire                                                                                |

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