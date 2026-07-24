---
name: ai-module-test-coverage
description: Test coverage gaps and quality patterns in the AI module. Includes the 11.32.x finding that CoreAiConnectionService has no unit spec and warnOnCapabilityDrift() is unreachable dead code against both shipped providers; plus the 2026-05-30 OAuth/MCP/hook gaps and brittle regex-on-message assertions.
metadata:
  type: project
---

The AI module ships two test files: `tests/ai.e2e-spec.ts` (~1346 lines) and `tests/unit/ai.spec.ts` (~2896 lines). Combined coverage is strong on the core orchestrator (CoreAiService) but leaves well-defined gaps.

**CoreAiConnectionService has NO unit spec at all (2026-07-24, 11.32.x review).** The service (create/update/delete/resolve + boot self-checks) is touched ONLY by `ai.e2e-spec.ts` (create/update/delete/resolve + eager capability detect + admin detect-capabilities HTTP + 403). Its `onModuleInit` boot self-checks are effectively untested behaviorally:
- **`warnOnCapabilityDrift()` is DEAD CODE against both shipped providers — and a test would have caught it.** The method only proceeds for a connection that DECLARES a boolean `supportsNativeTools`/`supportsJsonResponse`, then builds a provider from the resolved (declared) connection and calls `detectCapabilities()`. But `OpenAiCompatibleProvider.detectCapabilities()` probes ONLY flags left `undefined` and returns `{}` for a declared flag (PROVEN by the existing test `ai.spec.ts` "detectCapabilities returns false on 4xx and does not probe explicit flags" → `toEqual({})`, `fetchCount === 0`). So `typeof detected.X === 'boolean'` is always false for the declared flag → the drift branch is unreachable. `ClaudeCliProvider` has no `detectCapabilities` at all → skipped by the `typeof … !== 'function'` guard. Net: with either shipped provider the warning can NEVER fire. A test written from the method's JSDoc ("warn when a connection DECLARES a capability that contradicts the endpoint") cannot Arrange the trigger against the real provider contract — only a fictional mock that re-probes declared flags makes it fire (green test, false confidence). This is the exact trap where the test you'd naturally write is not the test that catches the bug.
- **e2e cannot cover it anyway:** the guard `['ci','e2e'].includes(process.env.NODE_ENV)` early-returns, and the e2e runner sets `NODE_ENV=e2e` (package.json:61). The UNIT runner (NODE_ENV defaults to `test`) does NOT hit the guard → a `tests/unit/core-ai-connection.service.spec.ts` with a mocked `mainDbModel` query chain + mocked `providerFactory` is the correct home (fast, no Mongo, method body actually executes).
- **`seedDefaultConnection()` config→model mapping is untested** — including the new `contextWindow` field. `seed` is spread into `mainDbModel.create({...rest})`, the model defines `contextWindow?: number` (core-ai-connection.model.ts), and `resolve()` maps `contextWindow: doc.contextWindow`. Whole chain wired, zero assertions. `contextWindow` appears in tests ONLY in the orchestrator `fit()` consumer (`ai.spec.ts` ~617/629/672) with a hand-built `{ contextWindow: 1000 }` — never the seed/resolve plumbing.
- **`assertStoredKeysDecryptable()`** broken-key error-log path: untested.
- **`detectAndPersistCapabilities()` new contextWindow branch** (`detectContextWindow` → `$set: { contextWindow }`): untested — the e2e `registerDetectProvider` fake has no `detectContextWindow`, so the branch never runs.

**Prior-review gaps (feature/ai-module, 2026-05-30) — still relevant:**

**Gaps worth flagging in future reviews:**
1. **OAuth 2.1 stores (P0).** `saveAuthorizationCode`, `consumeAuthorizationCode`, `issueRefreshToken`, `rotateRefreshToken`, `registerClient`, `getClient`, `loadUser` on `CoreAiMcpOAuthService` have ZERO test coverage. Only `signAccessToken` / `verifyAccessToken` / `verifyPkce` are unit-tested. `buildOAuthProvider` test only asserts function presence, not end-to-end flow. The `mountAiMcpOAuth` test only asserts `app.use` was called once with something truthy.
2. **MCP HTTP session lifecycle.** Only `POST /ai/mcp` (401-without-auth) is hit at the wire. `handleGet`/`handleDelete`/full Post→Get→Delete session flow against the controller is untested.
3. **Lifecycle hooks `sessionStart` / `stop`.** Only `preToolUse` and `postToolUse` have tests. The other two hook methods are dispatched in the orchestrator but never asserted.
4. **`search_tools` and `ask_user_question` tool implementations.** Both are referenced and behavior-tested via mocked replacements (the orchestrator's reaction to them), but their actual `execute()` bodies are not directly unit-tested.

**Brittle assertion pattern:** several service-level error tests assert raw English message strings via regex (`.toThrow(/admin/i)`, `.toThrow(/owner|denied|forbidden/i)`, `.toThrow(/invalid|scope/i)`). The corresponding source throws raw `new ForbiddenException('...string...')` instead of using `ErrorCode.AI_*` keys. This is a CODE-quality problem (mixing pattern: connection.service / resolver use `ErrorCode.AI_*`, while slot.service / prompt.service throw raw strings) AND a TEST-quality problem (assertions will break on i18n / message tweaks). Reviewers should flag both halves.

**Confirmed-safe isolation:** parallel-fork DB sharing rules from [[e2e-isolation-model]] hold — `ai*` collections are exclusively owned by `ai.e2e-spec.ts` so collection-wide `deleteMany({})` is fine. The "Must stay last" ordering for the `ai.allowedBaseUrlHosts` test in `tests/unit/ai.spec.ts` (line 1729) matches the [[configservice-singleton-in-tests]] mergeConfig array-clear semantics — verified.

**Minor isolation defect (low severity):** `iam_user` collection is mutated in `createHttpUser` (line 84) but NOT cleaned up in `afterAll`. The `users`, `account`, `session` collections are cleaned, but the BetterAuth user record leaks across runs. Not parallel-unsafe (filtered by unique timestamp+random email) but it does accumulate test garbage.

**Crypto-tampering not tested:** `AiCryptoService` roundtrip + empty-value tests exist; the auth-tag tampering case (decrypt should throw with key mismatch / corrupted value) is NOT tested, even though the source explicitly handles it.

**Budget tests:** `assertWithinBudget` boundary (used==max → 429) IS tested. `maxPrompts` exceeded branch is NOT tested (only `maxTokens`). `periodStart`/`nextReset` for `month` and `none` periods are NOT directly tested.
