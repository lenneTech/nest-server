---
name: e2e-isolation-model
description: How the nest-server Vitest e2e suite shares ONE database across parallel forks within a run — and the jwks landmine that makes "flaky 401s" a deterministic cross-file bug
metadata:
  type: project
---

The e2e suite (`vitest-e2e.config.ts`) runs `pool: 'forks'`, `fileParallelism: true`, `isolate: true`.

**DB model (corrected 2026-07-13 — earlier note here was stale):** `tests/global-setup.ts` gives every RUN its own database (`<base>-run-<ts>-p<pid>`), so two concurrent runs no longer clobber each other. But **within a single run, ALL test files still share that one database** — `isolate: true` isolates module state per fork, never the DB. So cross-RUN interference is fixed; cross-FILE interference is very much alive.

**Escape hatch:** `deriveTestDbUri(suffix)` (`tests/db-lifecycle.reporter.ts:44`) gives a file its OWN database. Already used by `error-code-scenarios`, `mongoose-plugins`, `multi-tenancy`, `tenant-guard`. Any file that mutates GLOBAL state (not just its own rows) belongs in this list.

## The jwks landmine (root cause of the recurring "flaky 401s")

`tests/stories/better-auth-integration.story.test.ts:962` runs `db.collection('jwks').deleteMany({})` in a `beforeAll` — an unscoped wipe of the **BetterAuth JWT signing keyset** — and that file does NOT use `deriveTestDbUri`. 19 e2e files boot BetterAuth-JWT apps against the same shared run DB.

Victim pattern: `tests/ai.e2e-spec.ts` mints Bearer tokens ONCE in `beforeAll` (:156-157) and reuses them across ~40 later tests. When the jwks wipe lands mid-file, BetterAuth regenerates the keyset and every previously-signed JWT becomes unverifiable → `expected 200 "OK", got 401 "Unauthorized"` on ~10 tests at once. `retry: 5` cannot save it — the token is *durably* dead, and every retry replays the same stale `beforeAll` token.

**Why it masquerades as an environment flake:** it is 100% deterministic *given the fork scheduling that pairs the two files*, and invisible otherwise. Verified 2026-07-13: 6/6 green across isolated runs, a full 51-file suite, and even two deliberately-concurrent full suites — yet `vitest run tests/ai.e2e-spec.ts tests/stories/better-auth-integration.story.test.ts` fails **4/4 on the branch and 2/2 on develop**. Do NOT accept "flaky under load / CPU contention" for this signature; that hypothesis is disproven.

**How to apply:**
- Pair-run the suspect file with the jwks-wiping file to reproduce a "flaky 401" on demand — that is the fastest discriminator, far better than re-running in isolation (which always passes).
- Treat unscoped `deleteMany({})` on shared auth collections (`jwks`, `session`, `account`, `users`) as a cross-file bug, not a local cleanup. Other files' cleanups here are correctly scoped (`$in` / email regex) — jwks is the outlier.
- Tokens minted once in `beforeAll` and reused across a long file are the vulnerable shape; re-minting per test (`beforeEach`) is the hardening.
- `tests/ai.e2e-spec.ts:90` claims a JWT-fallback fix "eliminates the pre-existing flaky 401s in this file" — it made token *acquisition* deterministic but does nothing about *invalidation* by a foreign jwks wipe. The comment is misleading; don't trust it as evidence the file is fixed.
