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

**Re-verified 2026-07-22 — the scope GREW since first recorded; do not trust an older reading.** It now emits seven things: (1) `CoreModule.forRoot()` overload signatures, (2) the allowlisted config interfaces, (3) `ServiceOptions`, (4) `CrudService` public method signatures, (5) a core-modules table built by scanning `src/core/modules/*` dirs for the mere *presence* of README.md / INTEGRATION-CHECKLIST.md, (6) **an "Errors & Status Codes" + "Exported error helpers" section** — `extractExceptions()` auto-discovers every exported class/function under `src/core/**/exceptions/*.ts` (genuinely auto-discovered, no allowlist), (7) a **"Key Source Files" table that is a hardcoded template literal** at the bottom of `main()`.

Two consequences that changed:

- The earlier note that the file "has NO exceptions/classes concept" is **WRONG as of 11.31.x** — a new file under any `exceptions/` dir DOES appear automatically, with its first JSDoc line as the summary. Only the `exceptions/` path is auto-discovered this way.
- `targetInterfaces` has grown to include `IAi`, `IAiRateLimit`, `IAiDefaultConnection` (they now have dedicated `###` sections). Re-read the array rather than reciting it.

Still true: **exported `const`s, DI tokens, and helpers under `src/core/common/helpers/` can never appear.** For such a change FRAMEWORK-API.md being date-only in the diff is structurally CORRECT, not staleness — but see [[main-ts-optin-api-has-no-doc-surface]]: "the generator can't emit it" is a reason to document it *elsewhere*, not a reason to grade the change fully documented. The hardcoded "Key Source Files" table is the one cheap lever for surfacing a new keystone file to Claude Code.

## Date-stamp churn is not a doc gap

Line 3 is `> Auto-generated from source code on YYYY-MM-DD (vX.Y.Z)`. Because the date is stamped fresh on every run, re-running the generator on an unchanged API produces a **1-line, date-only diff** — which shows up as a dirty `FRAMEWORK-API.md` in `git status`. That is build churn, not a pending documentation update. Verify with `git diff -- FRAMEWORK-API.md`: if the only hunk is the date line, the API surface is genuinely unchanged. Run it standalone via `npx tsx scripts/generate-framework-api.ts` (it is the last step of `pnpm run build`, so a full build is not needed to check).
