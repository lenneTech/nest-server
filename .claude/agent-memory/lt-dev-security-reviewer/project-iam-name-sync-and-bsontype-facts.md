---
name: project-iam-name-sync-and-bsontype-facts
description: DEV-3821 legacy->IAM name sync (native updateOne by email) traced sound; Better-Auth `name` is undeclared on CoreUserModel so it never reaches model-mapped responses; bson refuses any object carrying `_bsontype`
metadata:
  type: project
---

Reviewed 2026-10-27 (PR #646 / #647, both clean).

- **`CoreUserService.update()` name sync (DEV-3821)** writes `name` via
  `connection.collection('users').updateOne({ email }, { $set: { name } })`, email taken from the
  STORED record of the already-authorized `id`. Sound because email is globally unique in the
  starter and `src/server` (`unique: true`), create() checks it, and Better-Auth itself cannot
  operate with duplicate emails. The core model alone only has `index: true` — a project that drops
  the unique index would make every email-keyed sync (email/password/name, all pre-existing pattern)
  ambiguous; that is the re-check trigger.
- **Better-Auth `name` is not a declared field on CoreUserModel**, and `prepareMap()` copies only the
  target's own keys, so `name` is dropped from every REST/GraphQL user response. Putting a field the
  caller may not read into `name` therefore leaks nothing to other users; only `/iam/get-session`
  shows it, to the owner.
- **Reverse sync (`linkOrCreateUser`)**: `name` is a Better-Auth built-in, client-writable via
  `POST /iam/update-user`, and lands in firstName/lastName on the next sign-in (own record only,
  bypasses any project `@Restricted` on those fields). Pre-existing; DEV-3821 only NARROWED it to
  "name differs from stored first+last".
- **bson refuses to serialize any object carrying a `_bsontype` key** (top level: "BSON types cannot
  be serialized as a document"; nested: BSONVersionError). So a stored document can never carry it,
  and a skip keyed on `doc._bsontype` (mongooseIdPlugin, 12.0.x) cannot be triggered by stored data.
  Probe: `node -e "require('bson').serialize({_bsontype:'ObjectId'})"`.

**How to apply:** re-verify the email-uniqueness premise before reporting an email-keyed native
write as cross-user; do not report `name` as an exposure channel without first finding a reader.
Related: [[project-betterauth-input-false-enforcement]].
