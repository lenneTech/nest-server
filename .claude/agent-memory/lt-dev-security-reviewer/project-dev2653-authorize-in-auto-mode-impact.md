---
name: project-dev2653-authorize-in-auto-mode-impact
description: DEV-2653 (run AiTool.authorize() in auto+MCP mode) audited against lt-crm's 45 authorize()-tools — zero live authorization gaps; authorize() is uniformly weaker-or-equal to execute()
metadata:
  type: project
---

Audited 2026-07-22: all 45 `authorize()`-implementing AI tools in
`lt-crm/projects/api/src/server/modules/ai/tools/`, each traced through its `execute()`
service method(s) down to the actual ACL assertion.

## Verdict: no live gap. DEV-2653 is hardening, not a fix.

**Not one tool has an authorization check in `authorize()` that its `execute()` path lacks.**
Every one is weaker-or-equal. The reason is a consistent lt-crm convention worth knowing:

> The AI tool's `authorize()` MIRRORS a check; the SERVICE is the one that ENFORCES it.

Concretely, `authorize()` almost always calls the same `assertWriteAccess` / `canUse` /
`isSpaceAdmin` the service calls one layer down — and in ~10 cases the service is strictly
stronger (`archive_*`/`delete_*` add `isSpaceAdmin` + archived-precondition; `set_lead_private`
narrows write→`canManagePrivate`; the three source tools authorize on READ but the service
asserts WRITE; `merge_leads` adds tenant + archived + private checks).

**Why:** four tools that CANNOT express their boundary in the registry `roles` filter
(space roles live in the tenant membership, not `user.roles`) re-assert it inline at the top
of `execute()` — `backfill_contact_field`, `list_members`, `generate_space_exposee`,
`set_space_exposee`, `update_exposee_settings`, `update_scoring_settings`. That inline
`if (!isSpaceAdmin(...)) throw ForbiddenException` is what makes auto mode safe today.

**How to apply:** do not treat "tool has `authorize()` but runs in auto mode" as a finding
by itself in lt-crm. Verify the service. Only flag a tool whose `authorize()` names a check
the service genuinely does not perform.

## The one asymmetry that exists — and why it is not a gap

Five tools additionally require `!!RequestContext.get()?.tenantId` in `authorize()` while
`execute()` only checks `isSpaceAdmin` (`get_scoring_settings` checks only the tenantId).
`isSpaceAdmin()` is true for a global `RoleEnum.ADMIN` regardless of tenant, so this LOOKS
like a hole. It is not: `/ai/prompt` is `@Roles(S_USER)`, whose `CoreTenantGuard` branch
returns without setting `tenantId`/`tenantIds`/`isAdminBypass`, so the mongoose tenant
plugin's safety net throws first. Same denial, different error string.
(`ScoringSettingsService.getSettings` also carries its own explicit tenantId guard on the
lazy-seed write, citing the AI tool path by name.)

## Regression risk DEV-2653 introduces in lt-crm

- `batch_import_leads.authorize()` demands write access to the GENERAL group, but its
  `execute()` no longer needs it — since DEV-2495 `batchImport` passes no `groups`, so LMs
  are created ungrouped. The check is stale. Harmless while the general group exists and is
  `public` (it is, created per space in `SpaceService`), but a space that lost or privatised
  it would see batch import start failing.
- `list_sources.authorize()` and `delete_reminder.authorize()` perform a full service READ.
  Enabling them in auto mode doubles those queries per call.
- `create_source.authorize()` does no authorization at all — only arg validation. It would
  convert a 422 `SOURCE_INVALID` into an authz denial.

Related: [[project-ai-tool-authorization-chain]].
