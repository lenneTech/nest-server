---
name: nest-server-override-status
description: Where nest-server's pnpm overrides live, which are load-bearing vs inert, and the ws entry's 2026-08-19 status flip
metadata:
  type: project
---

# nest-server override status

**Overrides live in `pnpm-workspace.yaml` (`overrides:`), NOT `package.json`.** pnpm 11
stopped reading the `pnpm` field. `allowBuilds`, `auditConfig.ignoreGhsas`,
`minimumReleaseAge`/`minimumReleaseAgeExclude`, `peerDependencyRules`, `nodeLinker` are
all there too.

**Why this matters:** the file's own header block tracks each entry as LOAD-BEARING or
INERT, and that classification is part of the contract — an entry whose status changed
but whose comment still claims the old status is worse than no comment, because the next
maintainer trusts it.

**How to apply:** every maintenance run, re-check the classification against the resolved
tree and update the header list + the entry comment when one flips. Do not delete an
inert entry just for being inert — check its key shape first (below).

## The shape that makes an inert entry safe to keep

A **range-floored** key stops BELOW the target (`'ws@>=8.0.0 <8.21.0': '8.21.3'`). It can
only lift a vulnerable version up, never drag a newer patch down. Safe to keep forever.

A key whose range extends at or above the target (`'hono': '4.12.27'`) is a **hard pin** —
pnpm replaces the whole matched spec, so it silently downgrades. That shape must never
come back; it once dragged hono back four patch releases, reintroducing everything fixed
in between. The file documents this incident inline above the `hono` entry.

## Status flip recorded 2026-08-19

`ws` went LOAD-BEARING → INERT. `@nestjs/graphql@13.4.2` pinned the vulnerable `ws@8.20.1`
exactly (which is why the override existed); `13.4.5` pins `ws@8.21.3` itself, and
`graphql-ws@6.2.1` takes ws as an *optional peer*. Every 8.x consumer now requests 8.21.3
unaided. Kept anyway because the key is range-floored. Only `@hono/node-server` remains
load-bearing.

`ws@7.5.11` also resolves (via `subscriptions-transport-ws`) and is NOT matched by the
override — that is correct, 7.5.11 is already past the 7.x fix (7.5.10).

Related: [[deferred-major-updates]], [[nest-server-maintenance-gotchas]]
