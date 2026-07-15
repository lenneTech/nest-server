---
name: vitest-blind-to-swc-cjs-tdz
description: Why the nest-server vitest suite CANNOT catch SWC/CommonJS TDZ crashes from import cycles — and the cheap build+require guard that can
metadata:
  type: project
---

The vitest suite is **structurally incapable** of catching `ReferenceError: Cannot access 'X' before initialization` crashes caused by circular imports, even though both vitest configs use `unplugin-swc`.

**Why:** `unplugin-swc` runs SWC as a *Vite transform*. Vite's module runner rewrites imports into lazy, getter-based `__vite_ssr_import__` accessors, so a cycle resolves through live bindings evaluated on *access*. The TDZ window never opens. By contrast `nest start -b swc` / `nest build -b swc` emit **CommonJS**, and Node's CJS loader executes a partially-initialized module on a cycle → TDZ throw on the `const`. Verified empirically (2026-07-13): the crash trace goes through `Module._compile (node:internal/modules/cjs/loader)`.

**Consequence:** adding more vitest tests — including a DI-resolution test — can never guard this bug class. Only code compiled to CJS and *executed* reproduces it. `nest build -b swc` alone is useless: it **exits 0** (SWC does no cycle/type checking). The graph must be *loaded*.

**The cheap guard (verified as a perfect binary discriminator):**
```
npx nest build -b swc && node -e "require('./dist/index.js')"
```
Pre-fix → throws the exact production ReferenceError in seconds. Post-fix → loads clean. No MongoDB, no port, no server lifecycle. `@swc/core` + `@swc/cli` are already devDependencies. Must be ordered BEFORE `pnpm run build` in the `check:raw` chain, because `nest build` has `deleteOutDir: true` and `check-server-start.sh` needs the tsc `dist/`.

**Cycle inventory is NOT zero** — `madge --circular src/core/` reports 9 cycles (2026-07-13). A "zero cycles" assertion is therefore impossible, and a baseline/allowlist test has poor signal: most cycles are benign (type-only or deferred method-body access). The bug is never "a cycle" — it is **a cycle PLUS a module-evaluation-time access** of the cyclic binding. Decorators (`@Inject(TOKEN)`) are evaluated at class-definition = module-eval time, which is exactly what makes them TDZ-lethal; a lazy `Foo.bar()` inside a method body in the same cycle is harmless.

**How to apply when reviewing:** never accept "all tests green" as evidence that an import-cycle/module-init fix works. Ask for the SWC-CJS load guard. And when grading a cycle, check *where the binding is read* (decorator/top-level = dangerous; method body = safe), not merely whether a cycle exists. See [[e2e-isolation-model]] for the DB-sharing counterpart.
