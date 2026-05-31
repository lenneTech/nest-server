---
name: framework-api-generator-allowlist
description: FRAMEWORK-API.md only expands config interfaces named in a hardcoded list in scripts/generate-framework-api.ts; new interfaces are silently dropped
metadata:
  type: project
---

`scripts/generate-framework-api.ts` does NOT auto-discover all config interfaces. It has two hardcoded arrays: `targetInterfaces` (IServerOptions, IAuth, IMultiTenancy, IErrorCode, IJwt, ICookiesConfig, ICorsConfig, ICoreModuleOverrides) and `betterAuthInterfaces`. Only interfaces in these arrays get a dedicated `### IName` field-by-field section in FRAMEWORK-API.md.

**Why:** The CLAUDE.md framework-compatibility rule claims FRAMEWORK-API is "auto-generated... includes the new interface and all fields" — but that is only true if the interface name was added to the allowlist. A new top-level config interface (e.g. `IAi`, `IAiRateLimit`, `IAiDefaultConnection`) appears only as a `field?: boolean | IName` reference under its parent, never expanded, unless someone edits the generator.

**How to apply:** When reviewing a branch that adds a new config interface to `server-options.interface.ts`, do NOT treat "FRAMEWORK-API.md was regenerated" as sufficient. Grep FRAMEWORK-API.md for a dedicated `### <NewInterface>` heading. If absent, flag it AND flag the missing edit to the generator's `targetInterfaces` array — a one-time regeneration won't fix it.
