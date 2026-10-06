---
name: override-recipe-vs-consumer-lockfiles
description: A security-override recipe in a migration guide / docs/security-overrides.md must be checked against REAL consumer lockfiles, not the framework's own — older transitive lines escape a key scoped to the framework's resolved version
metadata:
  type: project
---

The framework's `pnpm-lock.yaml` is the freshest tree in the stack. Consumer lockfiles were resolved
weeks or months earlier and often hold an OLDER line of the same transitive package, reached through a
different requester. An override key written against what the framework resolves (e.g.
`'@graphql-tools/utils@>=12.0.0 <12.0.1'`) then silently misses that line, and the guide's
"run `pnpm audit`, the advisory must be gone" step fails with no documented remedy.

**Why (2026-10-06, 11.42.4 review):** GHSA-7mx3-vvmw-hjmv covers `@graphql-tools/utils <=12.0.0`. The
guide's key covered only 12.0.0 (the `@nestjs/graphql` exact pin). `turbo` (vendor mode, same
`@apollo/server` 5.5.1 the framework declares) resolves `@apollo/server > @graphql-tools/schema@10.0.33
> utils@11.1.0` — schema resolved before 10.1.0 (2026-08-12) still requests `^11`. Simulated in the
scratchpad: guide applied → audit still reports 11.x; `pnpm update --depth Infinity
@graphql-tools/schema @graphql-tools/merge` → clean.

**How to apply:** for every new override / lockfile-refresh instruction aimed at consumers:
1. Compare the advisory's affected range with the override KEY — any vulnerable line outside the key?
2. `grep -oE "'?<pkg>@[0-9][^(':]*" ~/code/lenneTech/{nest-server-starter,lt-crm,offers,turbo,b7capture}/pnpm-lock.yaml | sort -u`
3. Reproduce in the scratchpad: tiny package.json + `pnpm install --lockfile-only` + `pnpm audit --json`
   (works offline-ish, takes seconds). Seed an old line by first resolving with a temporary override.
`pnpm update --depth Infinity <transitive>` DOES lift a transitive dep in pnpm 11 without touching
package.json (verified). Related: [[doc-surfaces-for-config-features]].
