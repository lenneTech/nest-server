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
and is unusable for the decision. `getRawFileInfo()` checks S3 metadata first, then GridFS, so the
same rule works under either `file.storage`.

### 5. Decide how the frontend fetches files

A browser `<img src>` or `<a download>` cannot send an `Authorization` header, and a CORS preflight
sends no credentials at all. With anything stricter than `S_EVERYONE`, markup-driven requests only
work when the session travels as a **cookie** on a same-site request.

If some files are genuinely public and others are not, do not solve it with a role list. Either
record a visibility flag in the metadata and branch in `checkRights()`, or expose a separate public
route for exactly the public files and leave the core routes gated.

## Verification Checklist

- [ ] `pnpm run build` succeeds
- [ ] Anonymous `GET /files/id/<id>` answers **401**
- [ ] A signed-in non-privileged user answers **403** (not 401 — a 401 makes SPA auth layers log the
      user out)
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

## Common Mistakes

| Mistake                                            | Symptom                                  | Fix                                                                                                                    |
| -------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Overriding `getFileById` to add Swagger decorators | `file.downloadRoles` silently ignored    | Don't override; document at class level                                                                                |
| Overriding without re-declaring `@Get(...)`        | Route 404s for everyone, no error logged | Don't override                                                                                                         |
| `downloadRoles: []`                                | Warning logged, default applied          | Use a non-empty array; `[]` would read as "no roles required" and open the route                                       |
| Expecting `metadata` back from `getFileInfo()`     | `undefined`                              | Use `getRawFileInfo()` inside `checkRights()`                                                                          |
| `downloadRoles: ['member']` with multiTenancy      | Works from code, fails from `<img>`      | Both file classes carry `@SkipTenantCheck()`; roles resolve against `user.roles`. Use `checkRights()` for tenant rules |
| Signed-in user can upload via TUS but not download | 403 on their own file                    | `tus.roles` and `file.downloadRoles` are separate. Add an owner to the metadata and authorize per file                 |