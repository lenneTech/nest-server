---
name: ai-module-test-coverage
description: Test coverage gaps and quality patterns observed in the AI module review (feature/ai-module branch, 2026-05-30). What is well-covered, what is missing, and which "regex-on-error-message" assertions are brittle.
metadata:
  type: project
---

The AI module ships two test files: `tests/ai.e2e-spec.ts` (1130 lines, 48 `it()` blocks, one top-level describe) and `tests/unit/ai.spec.ts` (1885 lines, 13 describes, 60 `it()` blocks). Combined coverage is strong on the core orchestrator (CoreAiService) but leaves four well-defined gaps.

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
