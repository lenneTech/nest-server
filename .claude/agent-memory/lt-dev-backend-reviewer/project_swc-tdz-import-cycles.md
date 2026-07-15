---
name: swc-tdz-import-cycles
description: Import cycles in src/core only TDZ-crash under SWC when a binding is dereferenced at module-EVAL time (param decorators, static fields); check/CI has no SWC or madge step, so these are invisible to green CI.
metadata:
  type: project
---

Circular imports inside `src/core/**` are a live crash class under SWC (`nest start -b swc`),
but **only** when one side dereferences the other's binding during **module evaluation**.

**Why:** SWC's ESM→CJS emit exposes each export as a getter over a TDZ'd `const`/`class` binding.
On a cycle, the second `require()` returns a partially-populated exports object; touching a
property then fires the getter into the TDZ → `ReferenceError: Cannot access 'X' before initialization`.
tsc/CommonJS survives the same graph by evaluation-order luck. Fixed 2026-07 in
`better-auth` (commit 8786d83): `@Inject(BETTER_AUTH_INSTANCE)` sat in a **constructor-parameter
decorator**, which SWC evaluates at class-definition time (top-level statement).

**How to apply — the triage question is always "eval-time or lazy?":**
- CRASHES: constructor param decorators (`@Inject(X)`), class-level decorator *arguments*,
  `static` field initializers, top-level `const`, and `design:paramtypes` metadata
  (`typeof _mod.X` still fires the CJS getter).
- SAFE (latent): references only inside **method bodies** — resolved at request time, long after
  both modules finish evaluating.

To settle a verdict, compile the two files with `@swc/core` (commonjs + legacyDecorator +
decoratorMetadata) and grep the emit: a deref at column 0 / inside `_ts_decorate([...])` is a
crash; one inside a method body is not.

**Known latent (not crashing) as of 2026-07:** `better-auth-roles.guard.ts ↔ core-better-auth.module.ts`
(guard touches `CoreBetterAuthModule.getTokenServiceInstance()` only inside a method body; the module
touches the guard only inside `createDeferredModule()`). Repo-wide `madge --circular src/` reports
~10 cycles — treat that count as the baseline.

**Full 9-cycle audit (2026-07-13, SWC-emit verified).** Only 3 of madge's 9 are RUNTIME cycles;
#3/#6/#7/#8 emit an empty CJS file (type-only) and #5/#9 have a type-only return edge — all madge
false positives. Configure madge `skipTypeImports` to cut the noise.
- **`filter.input.ts ↔ combined-filter.input.ts` is ALREADY BROKEN** — `filter.input.ts:25`
  (`type: CombinedFilterInput`, eager) + its `design:type` metadata deref inside a top-level
  `_ts_decorate`. Deep-importing `combined-filter.input` FIRST throws today, zero source changes.
  The barrel survives only because 3 modules (`filter.args`, `filter.helper`, `single-filter.input`)
  pull `FilterInput` in first. **A `type: () => X` thunk does NOT fix it** — the crash just moves to
  the `_ts_metadata("design:type", …)` line, which `decoratorMetadata` emits eagerly and userland
  cannot make lazy. Only structural de-cycling (merge the mutually-recursive pair into one module) works.
- `restricted.decorator → db.helper → input.helper`: benign today; the exposed edge is the RETURN one
  (`input.helper` dereffing restricted's TDZ `const` arrows), not the one reviewers keep checking.
- `core-ai.service.ts:106` has a constructor-param `design:paramtypes` deref (the literal better-auth
  shape); the ONLY thing defusing it is `import type` on `core-ai-interaction.service.ts:8` —
  one IDE "organize imports" autofix away from a crash.

**Load-bearing `import type`:** in this repo `import type` is not cosmetic — it is what keeps several
cycles off the runtime graph. Never let a lint autofix widen one to a value import.

**Blind spot:** `pnpm run check` → `scripts/check.mjs` runs `nest build` (tsc) only. There is **no
SWC build and no madge/circular step** in check.mjs, check-server-start.sh, or .github/workflows/.
So this entire bug class keeps CI green and only detonates for consumers running `-b swc` —
especially **vendor-mode** consumers who copy `src/core/` into their own tree.
See [[core-errorcode]] for the other core-module consistency baseline.
