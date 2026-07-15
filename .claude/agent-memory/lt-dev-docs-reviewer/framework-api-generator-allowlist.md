---
name: framework-api-generator-allowlist
description: FRAMEWORK-API.md only expands config interfaces named in a hardcoded list in scripts/generate-framework-api.ts; new interfaces are silently dropped, and non-interface changes are structurally out of scope
metadata:
  type: project
---

`scripts/generate-framework-api.ts` does NOT auto-discover all config interfaces. It has two hardcoded arrays: `targetInterfaces` (IServerOptions, IAuth, IMultiTenancy, IErrorCode, IJwt, ICookiesConfig, ICorsConfig, ICoreModuleOverrides) and `betterAuthInterfaces`. Only interfaces in these arrays get a dedicated `### IName` field-by-field section in FRAMEWORK-API.md.

**Why:** The CLAUDE.md framework-compatibility rule claims FRAMEWORK-API is "auto-generated... includes the new interface and all fields" — but that is only true if the interface name was added to the allowlist. A new top-level config interface (e.g. `IAi`, `IAiRateLimit`, `IAiDefaultConnection`) appears only as a `field?: boolean | IName` reference under its parent, never expanded, unless someone edits the generator.

**How to apply:** When reviewing a branch that adds a new config interface to `server-options.interface.ts`, do NOT treat "FRAMEWORK-API.md was regenerated" as sufficient. Grep FRAMEWORK-API.md for a dedicated `### <NewInterface>` heading. If absent, flag it AND flag the missing edit to the generator's `targetInterfaces` array — a one-time regeneration won't fix it.

## The generator's TOTAL scope (everything else is legitimately N/A)

It emits exactly five things: (1) `CoreModule.forRoot()` overload signatures, (2) the allowlisted config interfaces, (3) `ServiceOptions`, (4) `CrudService` public method signatures, (5) a core-modules table built by scanning `src/core/modules/*` dirs for the mere *presence* of README.md / INTEGRATION-CHECKLIST.md.

Consequence: **exported `const`s, DI tokens, helpers, guards, middleware and new non-interface files can never appear in FRAMEWORK-API.md.** For such a change, FRAMEWORK-API.md being absent from the diff is CORRECT — do not flag it as a missed Living-Documentation update. Adding a new `.ts` file inside an existing module dir also changes nothing (the table only checks whether the two doc files exist).

## Date-stamp churn is not a doc gap

Line 3 is `> Auto-generated from source code on YYYY-MM-DD (vX.Y.Z)`. Because the date is stamped fresh on every run, re-running the generator on an unchanged API produces a **1-line, date-only diff** — which shows up as a dirty `FRAMEWORK-API.md` in `git status`. That is build churn, not a pending documentation update. Verify with `git diff -- FRAMEWORK-API.md`: if the only hunk is the date line, the API surface is genuinely unchanged. Run it standalone via `npx tsx scripts/generate-framework-api.ts` (it is the last step of `pnpm run build`, so a full build is not needed to check).
