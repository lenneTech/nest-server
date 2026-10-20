---
name: e2e-isolation-model
description: How the nest-server Vitest e2e suite isolates databases (per RUN, per FORK since 2026-07-15, per FILE via deriveTestDbUri) — and the historical jwks landmine behind the old "flaky 401s"
metadata:
  type: project
---

The e2e suite (`vitest-e2e.config.ts`) runs `pool: 'forks'`, `fileParallelism: true`, `isolate: true`.

**DB model (re-verified 2026-10-20 — the 2026-07-13 version of this note was stale):**

| Layer | Mechanism | DB name |
|---|---|---|
| per RUN | `tests/global-setup.ts` sets MONGODB_URI | `<base>-run-<ts>-p<pid>` |
| per FORK (since 2026-07-15, commit 3274b2d) | `tests/setup.ts` appends `-w<VITEST_POOL_ID>` before any import | `…-p<pid>-w<N>` |
| per FILE (opt-in) | `deriveTestDbUri('<suffix>')` from `tests/db-lifecycle.reporter.ts` | `…-w<N>-<suffix>` |

Files in DIFFERENT forks can no longer collide. Files that share a fork run SEQUENTIALLY on the same
`-w<N>` DB, so cross-file interference is now only sequential leftovers, not mid-run wipes. All of
them are dropped on a green run (reporter drops every DB with the run-DB prefix; seen in the run log
as `Test database cleanup: dropped …-w1-jwt-issuer`).

## The jwks landmine (historical root cause of the "flaky 401s")

`tests/stories/better-auth-integration.story.test.ts` runs an unscoped `db.collection('jwks').deleteMany({})`.
Before per-fork isolation, that wiped the JWT signing keyset of every PARALLEL file sharing the run DB;
files minting a Bearer token once in `beforeAll` (e.g. `tests/ai.e2e-spec.ts`) then got ~10 x 401 at
once, deterministically when the two files were scheduled together. Pair-running the two files was
the discriminator; "flaky under load" was disproven.

**How to apply now:**
- A spec that writes GLOBAL auth state (`jwks`, `session`, `account`) should still use `deriveTestDbUri`
  — it removes even the sequential-leftover risk and makes the spec's own isolation obvious.
- When a "flaky 401" reappears, first check whether the suspect file runs without the `-w` suffix
  (externally pinned URI already ending in `-w\d+`, or a spec building its own URI) before blaming load.
- Tokens minted once in `beforeAll` and reused across a long file remain the vulnerable shape.
