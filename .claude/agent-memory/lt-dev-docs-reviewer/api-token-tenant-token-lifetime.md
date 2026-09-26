---
name: api-token-tenant-token-lifetime
description: TENANT API tokens (11.41.4+) have no owner-existence check — only deleteAllForTenant()/revokeTenantToken() end them; any doc saying "access ends when the owner disappears" is wrong for them
metadata:
  type: project
---

`src/core/modules/api-token/`: a USER token dies with its owner (`loadTokenUser()` returns null → 401)
and with its membership (tenant restriction). A **TENANT token checks nothing about its tenant** —
`findUsableToken()` only requires `token.tenant` to be truthy, and the core has NO tenant model
(`CoreTenantService` has no delete). So a tenant token of a deleted tenant keeps authenticating with
the lowest tenant role in that tenantId until the project calls `CoreApiTokenService.deleteAllForTenant()`
or revokes it. Removing every member does not end it either (by design: "survives staff changes").
Pinned by `tests/api-token.e2e-spec.ts` A10.

**Why:** the first draft of the 11.41.4 docs said the opposite — INTEGRATION-CHECKLIST §4 "Access
already ends when the owner or the membership disappears — this removes the rows", README status
table "owner deleted → 401", tenant README "removes a tenant's tokens when the tenant is deleted"
(reads as automatic). That frames the ONLY off switch as optional housekeeping. Corrected in the same
review, before release: all three places plus a "Deleting or off-boarding a tenant" row in the
11.41.3-to-11.41.4 guide now say the call is what ends a tenant token.

**How to apply:** on any diff touching api-token docs, grep for "owner deleted", "already ends",
"when the tenant is deleted" and check each is scoped to USER tokens. If a later release adds a
tenant-existence hook, update this memory rather than re-flagging. Related: [[doc-surfaces-for-config-features]].
