---
name: configservice-singleton-in-tests
description: How ConfigService static-singleton state behaves across nest-server Vitest tests — per-file fork isolation makes it safe between files, but mergeConfig (lodash merge) means within-file config does NOT fully reset
metadata:
  type: project
---

`ConfigService` is a static singleton (`ConfigService._instance` + `_configSubject$`). In tests, calling `new ConfigService({ ai: {...} })` after first init runs `ConfigService.mergeConfig`, which does a lodash `merge` (deep merge), NOT a replace.

**Implication 1 — between files: SAFE.** The e2e config (`vitest-e2e.config.ts`) uses `pool: 'forks'` + `isolate: true`, so each test FILE runs in its own forked process with fresh static module state. `tests/unit/ai.spec.ts` and `tests/ai.e2e-spec.ts` cannot cross-contaminate each other's ConfigService.

**Implication 2 — within a file: ACCUMULATES.** Because `it()` blocks run sequentially and share one process, every `new ConfigService({ ai: {...} })` deep-merges onto prior config. Two consequences reviewers must check:
- Array configs do NOT clear via an empty array. `merge({a:['x']}, {a:[]})` → `{a:['x']}`. So a test that sets `ai.allowedBaseUrlHosts: ['host']` and "resets" with `new ConfigService({ ai: { allowedBaseUrlHosts: [] } })` does NOT actually clear it. The real safety mechanism is source ORDER — such a test must be the LAST in its describe/file (look for a "Must stay last" comment). Verify ordering, not the reset.
- A `beforeAll`-set config key persists into later describes unless explicitly overwritten with a non-empty value.

**How to apply when reviewing:** For singleton-config mutations in unit tests, the question is never "does it reset?" but "is it last, or does every later test overwrite the keys it cares about with explicit values?". The AI unit suite does the latter (each budget/confirmation test re-sets its full `ai.budget`/`ai.confirmation` block) plus keeps the allowlist test last — both valid. See [[e2e-isolation-model]] for the DB-sharing counterpart.
