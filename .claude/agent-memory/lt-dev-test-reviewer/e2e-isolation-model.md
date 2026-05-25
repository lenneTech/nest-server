---
name: e2e-isolation-model
description: How the nest-server Vitest e2e suite shares one MongoDB across parallel forks — implications for collection-wide deleteMany() in test files
metadata:
  type: project
---

The e2e suite (`vitest-e2e.config.ts`) runs with `pool: 'forks'`, `fileParallelism: true`, `isolate: true`. Despite `isolate: true` (which isolates module state per fork, NOT the database), every test file connects to the SAME MongoDB database (one of `nest-server-{ci,e2e,local,dev}` from `src/config.env.ts`, selected by `NODE_ENV`).

**Why:** There is no per-fork DB namespacing. The DB name is fixed per environment, not per worker.

**How to apply when reviewing test isolation:**
- A test file that does `db.collection('X').deleteMany({})` is only safe if NO OTHER test file touches collection `X`. Verify with `grep -rln "<collection>" tests/`.
- Within a single test file, `it()` blocks run sequentially (Vitest default), so a mid-file `deleteMany` is safe against that file's own later tests as long as they recreate their fixtures.
- The shared `users` collection IS touched by many files — tests that depend on user counts MUST scope to isolated users (unique `ObjectId`/`@test.com` emails), never assume a clean `users` collection.
- Cleanup filters keyed on `@test.com` emails are the suite convention; collection-wide `deleteMany({})` is acceptable ONLY for collections owned exclusively by one file (e.g. the AI module's `ai*` collections).
