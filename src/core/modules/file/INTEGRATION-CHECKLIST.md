# File Module Integration Checklist

## Reference Implementation

- Local: `node_modules/@lenne.tech/nest-server/src/server/modules/file/`
- GitHub: https://github.com/lenneTech/nest-server/tree/develop/src/server/modules/file

## Required Files (Create in Order)

### 1. FileService

**Create:** `src/server/modules/file/file.service.ts`
**Copy from:** Reference implementation.

Override `checkRights()` here if any file needs a per-file rule (owner, tenant, published flag).
Roles alone cannot express that — see step 4.

### 2. FileController

**Create:** `src/server/modules/file/file.controller.ts`
**Copy from:** Reference implementation.

**Do NOT override `getFileById` / `getFile`.** Role metadata lives on the function object, so an
override carries its own and opts the route out of `file.downloadRoles` permanently. Worse, an
override that omits `@Get(...)` unregisters the route entirely — 404 for everyone, with no error
and no warning. Add your project's own endpoints (upload, info, delete) alongside the inherited
ones instead.

### 3. FileModule

**Create:** `src/server/modules/file/file.module.ts`
**Copy from:** Reference implementation.

Register `FileController` and `FileService`. `CoreFileResolver` is **not** registered by any core
module — add it (or a subclass) yourself only if you want the GraphQL surface.

### 4. Configure access

**Edit:** `src/config.env.ts`

```typescript
file: {
  storage: 'gridfs',                // 'filesystem' | 'gridfs' | 's3' — omit to derive it
  storageDir: 'uploads/files',      // only for 'filesystem'
  downloadRoles: [RoleEnum.ADMIN],  // GET /files/id/:id, GET /files/:filename, getFileInfo
  uploadRoles:   [RoleEnum.ADMIN],  // uploadFile, uploadFiles (GraphQL)
  deleteRoles:   [RoleEnum.ADMIN],  // deleteFile (GraphQL)
},
tus: {
  roles: [RoleEnum.S_USER],         // resumable uploads
},
```

**WHY you may not need `storage` at all:** left unset it is derived — `'s3'` when `s3.bucket` is
configured, else `'gridfs'` when a database is, else `'filesystem'`. Set it when you want the choice
pinned regardless of what else is in the config. Either way, an unavailable store **fails the boot**
instead of silently falling back — see the module README, "Storage drivers".

**WHY these default to ADMIN:** the file store is one bucket shared by every feature of the project
— GridFS or S3, whichever `file.storage` selects — and the ObjectIds naming its blobs are not secrets:
one upload of your own bounds the id space enough to brute-force neighbours. Anything wider is a
decision worth making explicitly.

**WHY roles are not enough:** they answer "may this caller reach the endpoint", never "may this
caller have THIS file". For the latter, write an owner or tenant into the metadata at upload time
(`createFile(file, { metadata: { ownerId } })`) and compare it in `checkRights()` via
`getRawFileInfo()` / `getRawFileInfoByName()`. The public `getFileInfo()` strips restricted fields
and is unusable for the decision. Both raw lookups consult every store — S3 metadata first, then the
filesystem store, then GridFS — so the same rule works under any `file.storage`.

Handle **both** `checkInputType: 'id'` and `'filename'`. An id-only rule is enough while bytes are
streamed (the filename route resolves an id and re-checks it), but not with presigned S3 downloads,
and not for `deleteFileByName()`, which authorizes by name only.

**Copy from the executed reference, not from prose:** `src/server/modules/file/file.service.ts`
implements exactly this rule, and `src/config.env.ts` widens `file.downloadRoles` to `[S_USER]` so
it is actually reached. Note the internal callers there too — `{ force: true }` on the
`@Roles(ADMIN)` endpoints, and a real `{ currentUser }` in `AvatarController` — because a rule that
reads a missing user as "internal, allow" fails open the moment the coarse gate is widened.

### 5. Decide how the frontend fetches files

A browser `<img src>` or `<a download>` cannot send an `Authorization` header, and a CORS preflight
sends no credentials at all. With anything stricter than `S_EVERYONE`, markup-driven requests only
work when the session travels as a **cookie** on a same-site request.

If some files are genuinely public and others are not, do not solve it with a role list. Either
record a visibility flag in the metadata and branch in `checkRights()`, or expose a separate public
route for exactly the public files and leave the core routes gated.

## Pick your project class first — the whole model is one dial with four settings

The two layers (`file.*Roles` as the coarse audience filter, `checkRights()` as the per-file rule) cover
every project shape without forcing any of them. Decide which row you are, then verify only that row.

| Project class                                                   | `file.downloadRoles` / `uploadRoles` / `deleteRoles` | `checkRights()` override      | Why                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Open** — anyone may read, anyone may write                    | `[RoleEnum.S_EVERYONE]`                              | none                          | The gate IS the policy. Say it explicitly: `S_EVERYONE` must be a decision in `config.env.ts`, never the result of leaving something unset                                                                                                                                  |
| **Login-restricted** — every signed-in user may use every file  | `[RoleEnum.S_USER]`                                  | none                          | Also complete as-is. Be aware what it means: every signed-in user reads EVERY file, and ids are enumerable — so choose this only when the files really are shared                                                                                                           |
| **Tenant-based** — only within one's own tenant                 | `[RoleEnum.S_USER]` (or a project role)              | **required**                  | The stores sit outside Mongoose, so `mongooseTenantPlugin` never scopes them and a role name cannot express a tenant rule. Write `tenantId` into the metadata at upload and compare it. The framework WARNS at boot if you widen the gate without a rule                    |
| **Regulated** — explicit right to read, explicit right to write | narrow role for the coarse gate                      | **required, both directions** | Write: gate the upload/delete roles AND check the write right in `checkRights()`'s `'file'` / `'files'` branch. Read: check the read right in the `'id'` / `'filename'` branches and REFUSE `'filterArgs'`. Keep `s3.presignedDownloads` off so every byte access re-checks |

Two rules hold for all four rows:

1. **The coarse gate can grant but never exclude ADMIN** — both file classes carry a class-level
   `@Roles(ADMIN)` and the guards union class + handler metadata.
2. **`checkRights()` is the only place a per-file sentence can live.** No configuration can express
   "…but only their own", because that sentence needs data.

## The threat model, in four sentences

Read this before the checklist — it is what the checklist is checking.

**File ids are not secrets, and they are ENUMERABLE.** A MongoDB ObjectId is 4 bytes of timestamp +
5 bytes of randomness generated ONCE PER PROCESS + a 3-byte incrementing counter. Every id minted by
one server process therefore shares the same random part, so a caller who obtains a single valid id —
their own upload is enough — knows that part and a counter reference point; the ids of files the same
process created nearby in time sit on adjacent counter values. There is also **no rate limit on the
file routes** (the framework's limiters cover auth, IAM and AI only), so nothing throttles walking
that range.

The consequence: **the role gate is a coarse audience filter, never a per-file secret.**
`downloadRoles: [S_USER]` without an overridden `checkRights()` means every signed-in user can read
every file, and enumeration makes that practically reachable rather than theoretical. If files are
personal or medical, a per-file rule is not optional.

## Verification Checklist

- [ ] `pnpm run build` succeeds
- [ ] Anonymous `GET /files/id/<id>` answers **401**
- [ ] A signed-in non-privileged user answers **403** when the ROLE GATE is what refuses (not 401 —
      a 401 makes SPA auth layers log the user out). If you widened `downloadRoles` and let
      `checkRights()` decide instead, the expected answer is **404**, byte-identical to an unknown
      id — a 403 there would confirm the file exists
- [ ] A caller holding a configured role downloads successfully
- [ ] If you set `file.downloadRoles`, the value actually takes effect — if it does not, something
      in your controller is overriding the member (see step 2)
- [ ] TUS upload works for a signed-in user and is refused anonymously
- [ ] The boot log names the driver you expect (`[CoreFileStorage] File storage: …`)
- [ ] With `file.storage: 's3'`: a per-file rule in `checkRights()` still fires (it reads S3 metadata
      via `getRawFileInfo()`), and any presigned-download expiry is short enough for your audience
- [ ] With `file.storage: 'filesystem'`: `storageDir` is a **mounted volume** if the container is
      ever restarted or scaled — the directory is pod-local
- [ ] `OPTIONS /tus` answers without credentials (browser preflight)
- [ ] Avatars / images in the frontend still render for the roles that should see them

### Security checklist — the questions an audit will ask

- [ ] **Is `checkRights()` overridden at all?** If `downloadRoles` names anything beyond `ADMIN` and it
      is not, every holder of that role can read every file, by enumeration. With `multiTenancy`
      active the framework warns at boot; without it, nothing does — this checkbox is the only guard
- [ ] **Does the rule cover all four branches?** `'id'`, `'filename'`, `'filterArgs'` and the writes.
      `'filename'` is not redundant (the presigned path authorizes on the by-name lookup alone, and
      `deleteFileByName()` authorizes by name only), and `'filterArgs'` must be **refused** — a yes/no
      hook cannot narrow a listing, so returning `true` there hands over a full inventory
- [ ] **Does the rule FAIL CLOSED on a missing `currentUser`?** `if (!options.currentUser) return true`
      reads as "system call" but is also what an anonymous request looks like
- [ ] **Does it require the owner field to be PRESENT?** Without `!!raw?.metadata?.ownerId`, an
      owner-less file compares `undefined` with `undefined` and matches
- [ ] **Is a per-user LISTING forced server-side?** Build the filter from `currentUser` and pass
      `{ force: true }`. Never inspect the caller's own `filterArgs` to decide whether they are
      already narrowed — that is validating client input
- [ ] **Multi-tenant: is `tenantId` in the metadata and compared?** The stores are reached outside
      Mongoose, so `mongooseTenantPlugin` never scopes them and a role name cannot express a tenant
      rule. Nothing else can do this for you
- [ ] **Is `s3.presignedDownloads` off** (it is by default) — or, if on, is the expiry short and the
      audience genuinely "anyone who once held the link"? The URL works without a session, from any
      IP, and cannot be revoked
- [ ] **Are `/files/*` and `/tus/*` rate-limited in the reverse proxy?** The framework does not
      throttle them, and ids are enumerable
- [ ] **Do downloads go through the ID route, not the filename route?** Filenames are unique in no
      store and are chosen by the uploader, so a name can be squatted; the by-name path resolves the
      MOST RECENT file of that name
- [ ] **Does anything read files WITHOUT `CoreFileService`?** Direct GridFS or S3-SDK access bypasses
      `checkRights()` entirely

## Common Mistakes

| Mistake                                            | Symptom                                  | Fix                                                                                                                    |
| -------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Overriding `getFileById` to add Swagger decorators | `file.downloadRoles` silently ignored    | Don't override; document at class level                                                                                |
| Overriding without re-declaring `@Get(...)`        | Route 404s for everyone, no error logged | Don't override                                                                                                         |
| `downloadRoles: []`                                | Warning logged, default applied          | Use a non-empty array; `[]` would read as "no roles required" and open the route                                       |
| Expecting `metadata` back from `getFileInfo()`     | `undefined`                              | Use `getRawFileInfo()` inside `checkRights()`                                                                          |
| `downloadRoles: ['member']` with multiTenancy      | Works from code, fails from `<img>`      | Both file classes carry `@SkipTenantCheck()`; roles resolve against `user.roles`. Use `checkRights()` for tenant rules |
| Signed-in user can upload via TUS but not download | 403 on their own file                    | `tus.roles` and `file.downloadRoles` are separate. Add an owner to the metadata and authorize per file                 |
| Rule narrows only `'id'` / `'filename'`            | `findFileInfo()` returns every file      | Refuse `'filterArgs'`; force a per-user filter server-side with `{ force: true }`                                      |
| Treating the file id as unguessable                | Enumerable inventory                     | Ids share a per-process random part and an incrementing counter — authorize every read, do not rely on the id          |
| Approving the caller's `filterArgs` as "narrowed"  | Bypass via a different filter shape      | `filterArgs` is client-controlled. Override the filter; never approve it                                               |