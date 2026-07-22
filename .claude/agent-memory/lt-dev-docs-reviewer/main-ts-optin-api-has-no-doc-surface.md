---
name: main-ts-optin-api-has-no-doc-surface
description: A helper exported from src/index.ts that consumers must wire into their OWN main.ts has zero automatic doc surface — the migration guide is the only place it can reach them
metadata:
  type: project
---

When nest-server adds a public API that only takes effect if the consumer edits **their own `main.ts`** (e.g. `installProcessDiagnostics()` / `handleFatalBootstrapError` in 11.31.3+, or `mountAiMcpOAuth(app)` before it), **no automatic documentation surface covers it**:

- `FRAMEWORK-API.md` — the generator cannot emit `src/core/common/helpers/**` at all (see [[framework-api-generator-allowlist]]).
- `docs/REQUEST-LIFECYCLE.md` — its mandate is the request/response flow. A process-lifecycle concern (signal/exit/unhandledRejection handlers) adds no route, middleware, guard or interceptor, so a strict reading excludes it.
- `src/core/modules/*/README.md` — doesn't apply; the code lives in `common/helpers`, which has no README convention.
- This repo's own `src/main.ts` — updated, but consumers never receive it. `src/main.ts` is framework-testing scaffolding, not a shipped component.

**Why:** These APIs are invisible-by-construction. The consumer's `main.ts` is *their* file; `pnpm update` will never touch it. So the feature ships 100% inert into every project unless a human reads a guide and pastes two lines. That is the exact "developer must do something to benefit" trigger in `.claude/rules/migration-guides.md`.

**How to apply:** When a diff adds an export to `src/index.ts` AND wires it into this repo's `src/main.ts`, treat the **migration guide as mandatory**, and check specifically whether it shows the two-line `main.ts` snippet. Do not accept a rich source-level `@example` as a substitute — consumers read guides, not `node_modules/**/*.ts`. Distinguish the two REQUEST-LIFECYCLE cases: `mountAiMcpOAuth` IS listed there because it mounts **routes**; a pure process-lifecycle helper is not analogous. The defensible middle position is the doc's own "Features Overview → Development & Operations" table, which the Hub entry already uses for non-request operational features.
