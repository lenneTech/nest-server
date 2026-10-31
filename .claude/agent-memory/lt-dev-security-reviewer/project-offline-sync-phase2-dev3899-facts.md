---
name: project-offline-sync-phase2-dev3899-facts
description: DEV-3899 offline-sync cursor prototype review (2026-10-31) — ObjectId-default client ids can be squatted by a colleague; per-(model, tenant) counter breaks header-less multi-tenant pulls; prototype drop paths sound
metadata:
  type: project
---

Reviewed the phase-2 branch `feature/dev-3899-offline-sync-cursor-prototyp` on 2026-10-31 (no `src/` change; prototypes
under `.claude/plans/offline-sync/prototypes/`, not in the npm `files` list; `docs/offline-sync-protocol.md` IS shipped).

Reported:

1. **Client-id squatting under the ObjectId default.** The diff turned "prefer uuidv7" into "ObjectId-hex default,
   any ObjectId generator" and claims the hardening is format-independent. bson `ObjectId.generate()` = seconds +
   5-byte PROCESS_UNIQUE (once per module load) + counter (+1 per id), so one observed id of a colleague's current
   client session predicts its next ids up to the second. E6 regenerates only SERVER ids; the server "never rewrites a
   client id". Squat (create, optionally delete → quiet tombstone) → victim's create answers `conflict` with a
   tombstone (looks like "deleted elsewhere") or `ID_UNAVAILABLE`; follow-up `baseVersion: 1` items of the same batch
   apply to an attacker-created version-1 record. Fix: client ObjectIds = timestamp + 8 CSPRNG bytes per id.
2. **Per-(model, tenant) sync counter vs. header-less pulls.** `CoreTenantGuard` scopes a header-less request to
   `tenantIds` ($in, all memberships); independent per-tenant sequences under one `sync_seq > pos` keyset lose the
   lagging tenant's changes. Plan lists per-tenant counters as unproven (§5) but records them as the decision (§3.4).

Verified sound: DB names fixed prefix `nest_server_proto_test_*` / `nest-server-proto-test-*`, target names from a
fixed map, `CURSOR_DB_SUFFIX` only appends; credentials = test-container defaults; no user paths / customer names.

**How to apply:** in the phase-3/4 reviews (DEV-3900/3901) check the client-id generator rule and the tenant
dimension of the cursor position. Related: [[project-offline-sync-spec-dev3898-facts]]
