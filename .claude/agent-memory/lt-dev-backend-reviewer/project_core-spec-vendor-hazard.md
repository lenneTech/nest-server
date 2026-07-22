---
name: core-spec-vendor-hazard
description: Spec files under src/core/ are copied verbatim into vendored consumer projects and DO run there — so a core spec that reads repo-root files (process.cwd()) breaks every vendor consumer.
metadata:
  type: project
---

A `*.spec.ts` under `src/core/**` is not framework-repo-only. It is shipped to npm
(`files: ["src/**/*"]`) AND copied verbatim into vendor-mode projects, where it actually
executes.

**Why:** `convertCloneToVendored()` in `lenneTech/cli/src/extensions/server.ts` (~line 1220)
does `filesystem.copy(tmpClone/src/core, <api>/src/core)` with **no `*.spec.ts` filter**, and
the starter's `vitest.config.ts` includes `src/**/*.spec.ts` — which in vendor mode matches
`src/core/**`. The flatten-fix also relocates `src/index.ts` → `src/core/index.ts`, so a spec
doing `readFileSync(join(process.cwd(), 'src/index.ts'))` throws ENOENT in every vendored
project. Assertions on `src/main.ts` / `nodemon.json` likewise fail for any existing project
that has not adopted the framework's own wiring.

**How to apply:** when reviewing a new spec under `src/core/`, check for `process.cwd()`,
repo-root path literals, and assertions about files outside `src/core/`. Those belong in
`tests/unit/` (never copied to consumers) — the nest-server-starter does exactly this with
`tests/unit/bootstrap-diagnostics.spec.ts`. Pure-logic describes can stay in `src/core/`.
This is the *behavioral* form of the repo's "keep src/core self-contained" rule; the
import-graph check (madge / check:swc-tdz) cannot catch it. As of 2026-07-22,
`process-diagnostics.helper.spec.ts` was the first core spec to trip it.
