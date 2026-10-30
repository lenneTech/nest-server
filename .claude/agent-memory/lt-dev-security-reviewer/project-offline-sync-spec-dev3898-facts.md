---
name: project-offline-sync-spec-dev3898-facts
description: DEV-3898 offline-sync spec review (2026-10-29) — route @Roles not carried to /sync, create-repeat equality oracle, client ObjectId squatting of server ids; re-verify in phase-4 (DEV-3901) review
metadata:
  type: project
---

Reviewed the phase-1 spec (`docs/offline-sync-protocol.md`, `.claude/plans/offline-sync/PLAN.md`) on 2026-10-29.
Nothing implemented yet; phase 4 (DEV-3901) builds `src/core/modules/sync/`. Three findings were reported:

1. **Route-level authorization is not carried to `/sync`.** The plan maps "same rights as every other request" to
   "call the model's CrudService with the caller's ServiceOptions". CrudService has no operation-level gate of its own:
   `process()` only checks `serviceOptions.roles` (check() in input.helper.ts) when the CALLER passes them. The lt CLI
   template controller (`cli/src/templates/nest-server-module/template.controller.ts.ejs`) passes
   `roles: [ADMIN, S_CREATOR]` to update/delete at the call site, and every generated field is `roles: S_EVERYONE`,
   OR-merged with the class-level `@Restricted(ADMIN)` (`mergeRoles: true`) → field checks pass for everyone. So a
   sync push on a model whose read is broader than its write (default CoreModel securityCheck) writes/tombstones what
   REST refuses. Same class as role-system.md "Every entry point, not just the route (11.42.0)".
2. **Create-repeat comparison is an equality oracle.** §3/§6.5 + PLAN §3.7: a create on an id the caller may SEE
   compares the STORED record with `data` → `applied`/`conflict`. Fields output-restricted from the caller but present
   in the create input leak one guess per item.
3. **Client ObjectId-hex ids share the server's id space.** `generateId()` (id-format.ts) = seconds + fixed
   PROCESS_UNIQUE + counter+1; Mongoose/bson the same. One observed server id lets any sync user squat the next ones →
   other tenants' normal-API creates hit a duplicate key (PK uniqueness ignores tenant/RLS).

**Fixed in the spec before the merge (2026-10-29):** `sync.roles` per operation (pull/create/update/delete), passed as
`serviceOptions.roles`, deny by default (ADMIN only), pull roles also gate both hint channels; a repeated create is
ALWAYS answered `conflict` with the caller's view (no comparison at all); a server-generated id of a sync model that
meets a duplicate key is regenerated and retried (E6).

**How to apply:** in the phase-4 review, check that the implementation does exactly that — roles actually passed on
every CrudService call of the module (delete checked against the delete roles), no code path comparing stored values
with a repeated create's `data`, and the bounded id retry on server-generated ids. Verified-sound items: push CSRF
(JSON + Origin + Sec-Fetch-Site), cursor HMAC + fp binding, tenant filtering of tombstones/hints, uniform not_found.
O1/O2 are owner-declared — not findings unless their stated consequence is wrong.

Related: [[project-roles-metadata-merge-semantics]], [[project-api-token-module-security-model]]
