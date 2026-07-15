---
name: swc-cjs-tdz-and-ci-gap
description: Circular-import TDZ crashes only reproduce under SWC->CJS + Node require (nest start -b swc); vitest's unplugin-swc does NOT cover it, so CI is green while dev crashes. Includes the cycle-triage rule.
metadata:
  type: project
---

Circular imports in this repo can crash `nest start -b swc` with
`ReferenceError: Cannot access 'X' before initialization` while **CI stays green**.

**Why:** `nest build` uses **tsc** (`nest-cli.json` has no `"builder": "swc"`), so the
published `dist/` never sees SWC semantics. SWC *is* used in two places — the dev
scripts (`start:dev:swc`, `start:local:swc`) and **vitest** (both `vitest.config.ts`
and `vitest-e2e.config.ts` use `unplugin-swc`). But vitest runs SWC output through
**Vite's module runner** (ESM live bindings via getters, cycle-tolerant), *not*
through Node's CJS `require()` on SWC's emitted CJS. The TDZ only manifests in the
**SWC-CJS + Node-CJS-loader** combination that `nest start -b swc` produces, and
**no CI job runs that**. This is how the `BETTER_AUTH_INSTANCE` TDZ bug shipped to
develop with a green pipeline.

**Cycle-triage rule** — a cycle is only fatal when it carries a **TDZ-subject binding**
(`const` / `class` / `let`) that is **dereferenced during module evaluation**:

| Binding in the cycle | Deref timing | Fatal? |
|---|---|---|
| `const` (e.g. a DI token string) | module-eval, e.g. inside an `@Inject()` **parameter decorator** | **YES** — this was the bug |
| `class` | deferred into a method / factory body | No, but **latent** — moving the deref to a decorator arg or static initializer reintroduces the crash |
| `export function` | any | No — function declarations are **hoisted**, TDZ-immune |
| type-only (`Type<Foo>`, interfaces) | erased at compile | No — not a runtime cycle at all (madge reports these as false positives) |

**How to reproduce/verify a suspected cycle** (cheap, no MongoDB needed):
SWC-compile with `module: { type: "commonjs" }` + legacy decorators + decoratorMetadata,
then plain `node -e "require('<out>/core/modules/<mod>/<file>.js')"`. Throws on a fatal
cycle, silent otherwise. Diff the same require against a `git worktree` of the base branch
to get a clean A/B.

**How to apply:** When reviewing anything that touches the import graph in `src/core/`,
do NOT trust green CI as evidence that the SWC path is safe. Run `madge --circular
--extensions ts src/core/...`, then triage each cycle with the table above — most are
benign (`function` / type-only), so report only cycles carrying `const`/`class` bindings.
Known latent one (pre-existing, NOT yet fixed): `better-auth-roles.guard.ts` ↔
`core-better-auth.module.ts` — a `class` cycle, currently benign only because both
dereference sites sit in deferred function bodies.

Related: [[ai-module-perf]]
