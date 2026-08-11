---
name: multi-replica-file-storage
description: Review findings for the 11.33.0 multi-replica branch (feat/dev-2985) — the read-path asymmetry in CoreFileService and the migration-guide contradiction about a derived S3 driver
metadata:
  type: project
---

Reviewed `multi-replica statelessness` (11.32.4 → 11.33.0, branch `feat/dev-2985`).

**Two real defects found in `src/core/modules/file/core-file.service.ts`:**

1. `getRawFileInfoByName()` (~line 505) consults S3 → GridFS but SKIPS
   `findFilesystemFileByName()`. Every other by-name read path (`getFileInfoByName`,
   ~line 324) consults all three. Under `file.storage: 'filesystem'`, an overridden
   `checkRights()` on the `checkInputType: 'filename'` branch therefore sees `null`
   for a file that exists — the documented example pattern then 404s a legitimate
   download, and an inverted rule ("no raw info → allow") fails OPEN.
2. `findS3FileById` / `findS3FileByName` are gated on `this.s3Storage` (the CURRENT
   driver), while `findFilesystemFileById/ByName` are not. So "reads consult every
   store, switching is forward-only" holds when adopting S3 but NOT when switching
   away from it — S3-stored files go unreadable.

**Migration-guide contradiction (§7 of `migration-guides/11.32.x-to-11.33.x.md`):** the
section says both "a derived driver is enforced — the boot FAILS" AND, at the bottom,
"Without that third argument the service behaves exactly as before and stores everything
in GridFS". The code (`assertFileStorageAvailable`) makes the first true and the second
false: `s3.bucket` present + a `FileService` not forwarding `s3Service` to `super()` =
boot failure. There is no §11b for a pre-existing `s3` key the way §11a exists for `redis`.

**Also unmentioned in the guide:** `CoreCronJobs.initCronJobs()` and
`onApplicationBootstrap()` became `async` — a source break for a subclass overriding them.

**Verified non-issues (do not re-flag):** madge reports 6 cycles, all accounted for in
`.claude/rules/architecture.md` (5 type-only + the deliberate `user.module ↔ file.module`
forwardRef); no `src/core` → `src/server` import was introduced; the
`connection.db.collection()` use for `cron-locks` / `s3-files` / `filesystem-files` is the
documented schema-less exception; all five new peers are `optional: true` and dev-only;
oxlint is clean; the `Reflect.defineMetadata('roles', …)` runtime role wiring in
`file-roles.helper.ts` / `TusModule.applyRoles` is the same pattern `CorePermissionsModule`
uses, and the OPTIONS-handler carve-out for the tus CORS preflight is correct.

**Why:** so a follow-up review does not re-derive the read-path trace or re-flag the
runtime-role-metadata pattern.
**How to apply:** when reviewing follow-up diffs in `src/core/modules/file/`, check whether
`getRawFileInfoByName` gained the filesystem lookup and whether the s3 read gate was
dropped; check the guide for the §7 contradiction and a cron-override note.
