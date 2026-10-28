---
name: project-db-agnostic-phase4-ai-file-sweep-facts
description: DEV-3832 (db-agnostic phase 4) review 2026-10-28 — partial-TTL sweep data loss (finding), what was traced sound in MCP OAuth/file metadata/AI stores, and a pre-existing conversation-append IDOR judged below bar
metadata:
  type: project
---

Phase 4 review (feat/db-agnostic, 03be373..7ee8cba): one Critical (data loss), no security hole.

**Why:** so the next review re-tests the named spots instead of re-deriving them, and checks whether the finding was fixed.

**How to apply — the finding (re-check):**
- `DataSourceRuntime.sweepExpired()` builds its delete filter from `FieldDescriptor.expiresAfterSeconds` only; the
  descriptor (`model-metadata.registry.ts` `describeField`) reads the TTL index but drops `partialFilterExpression`.
  A project model on SQL with `schema.index({ createdAt: 1 }, { expireAfterSeconds, partialFilterExpression: {…} })`
  loses EVERY row past the TTL, not just the partial ones. Probed: delete where was `{ createdAt: { $lt } }` alone.
  Probe recipe: scratch vitest config with `root` = repo, `test.dir` = scratch dir, swc plugin with decorators;
  `registerModelSchema()` + `(new DataSourceRuntime(...) as any).stores.set(name, Promise.resolve(fakeStore))`.

**Traced sound (re-verify only if the named code changes):**
- MCP OAuth on SQL: `SqlDataStore.deleteOne` = `DELETE … WHERE id = (SELECT … LIMIT 1 FOR UPDATE) AND recheck
  RETURNING` → single consumption; code filter `{clientId, code}`, refresh `{clientId, token}` both bound; `liveCode()`
  refuses missing/old `createdAt` on both read paths; `loadUser()` has the SQL branch (phase-3 finding FIXED).
- `sqlFileCollection()`: user filterArgs go to the where compiler — unknown fields and unsupported operators are
  REFUSED (never dropped), JSON path segments and values are bound params; tables not tenant-scoped, same as Mongo.
- `neutralSelect`/`assertProjection`: names regex-checked, exclusion never adds `select:false` columns on SQL.
- Budget `sum()` under `runWithBypassTenantGuard`: callers always pass userId or tenantId (parity with native agg).
- Sweeps have no request entry point; `runNow()` has no production caller.

**Below bar (pre-existing, not made reachable by phase 4):** `CoreAiConversationService.appendMessage()` has no owner
check; `POST /ai/prompt { conversationId: <foreign id> }` (S_USER) appends into another user's conversation (same
tenant) after `loadRecentMessages` fail-softs to `[]` — a prompt-injection channel into the victim's later runs.
Needs the victim's ObjectId (no oracle, one LLM run per guess) → judged Medium. Report it if a diff makes ids
discoverable or touches the prompt pipeline's conversation handling.

Related: [[project-db-agnostic-phase3-better-auth-sql-facts]], [[project-ai-mcp-oauth-refresh-token-binding]].
