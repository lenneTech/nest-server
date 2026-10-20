---
name: framework-api-generator-probe
description: scripts/generate-framework-api.ts has no spec; how to exercise its write/skip logic without touching the tracked FRAMEWORK-API.md, and why a missing test there is not High
metadata:
  type: project
---

`scripts/generate-framework-api.ts` (runs as the last step of `pnpm run build`, so inside `check`) has
no unit spec. Since 2026-10-20 it skips the write when the existing file differs only in the
`as of YYYY-MM-DD` clause of the header line, so the committed date stays frozen until the API
surface or the version changes.

**Why a missing test there is not High:** the only stripped part is the date clause, so a wrong
comparison can at worst keep a stale doc file (not shipped code) or rewrite it needlessly. Runtime
breakage is already caught, because `build` executes the script under tsx.

**How to probe it without dirtying the tree:** `ROOT` and `OUTPUT` are hard-coded. sed them into a
scratch copy (`const ROOT = '<repo>'`, `const OUTPUT = process.env.OUT`), then run
`OUT=<scratch>.md NODE_PATH=<repo>/node_modules <repo>/node_modules/.bin/tsx <scratch>/gen.ts`
against seeded copies of `git show HEAD:FRAMEWORK-API.md`. Check five cases: other date only → "up to
date", untouched. Content row removed → rewritten. Version string changed → rewritten. Dateless file →
kept (harmless). Missing file → written. All five verified 2026-10-20. Takes about 10s per run
(ts-morph load).

Quick tell without probing: after a green `check`, `git status` showing FRAMEWORK-API.md clean while
`git log -1 --format=%cs` differs from the header date proves the skip path ran.
