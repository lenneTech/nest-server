---
name: pnpm-overrides-propagation
description: pnpm-workspace.yaml overrides do NOT reach npm consumers of @lenne.tech/nest-server; @nestjs/graphql exact-pins vulnerable ws@8.20.1. Plus how to run the override-necessity test and pnpm's downgrade-lock mechanic.
metadata:
  type: project
---

# pnpm overrides in nest-server protect ONLY this repo — never the consumers

`pnpm-workspace.yaml` → `overrides:` is read **only when the package is the root project**. When a
downstream project installs `@lenne.tech/nest-server` from npm, pnpm reads *their* root overrides,
not the dependency's. Every security override in this repo therefore fixes CI/dev here and does
**nothing** for consumer projects.

**Why:** verified 2026-07-22 during the Brevo-upgrade / 8-new-overrides review. The confirmed live
consequence: `@nestjs/graphql@13.4.2` declares `"ws": "8.20.1"` as an **exact pin** (not a caret) —
and 8.20.1 is GHSA-96hv-2xvq-fx4p (high, memory-exhaustion DoS + uninitialized memory disclosure,
patched >= 8.21.0). An exact pin cannot be resolved away, and `@nestjs/graphql` is a plain
`dependencies` entry of nest-server. So **every consumer project with GraphQL ships vulnerable `ws`**
unless it copies the override itself. nest-server's own `ws: 8.21.1` direct dep does not help — both
versions coexist in the tree and `@nestjs/graphql` binds to its nested 8.20.1.

**How to apply:** when reviewing any override/audit change in this repo, always ask the second
question — "does the consumer inherit the fix?" A clean `pnpm audit` here is not evidence about
downstream. Per the global "Grund-Repos" rule, the durable fix belongs in `nest-server-starter`'s
`pnpm-workspace.yaml` (the template every project starts from) and/or a shipped doc under `docs/**`
(which IS in the npm `files` array). Do not accept "pnpm audit is green" as closing the finding.

## The override-necessity test (project rule requires it)

`.claude/rules/package-management.md` demands proving each override is load-bearing. Cheap recipe
(~2 s, network only, no node_modules):

```bash
mkdir -p /tmp/ovr && cp package.json pnpm-workspace.yaml /tmp/ovr/
# strip the whole `overrides:` block from the copy, then:
cd /tmp/ovr && pnpm install --lockfile-only --ignore-scripts
grep -nE "^  <pkg>@" pnpm-lock.yaml     # compare against the real lockfile
```

Result of the 2026-07-22 run (10 entries): only **2 are load-bearing** — `ws` (regresses to the
exact-pinned 8.20.1) and `@hono/node-server` (regresses to 1.19.14; the MCP SDK declares `^1.19.9`
and there is no 1.x fix line). The other 8 (`axios`, 3× `brace-expansion`, `js-yaml`, `fast-uri`,
`body-parser`, `hono`) already resolve to patched versions without the override.

## pnpm's `pkg@<range>` override is a DOWNGRADE-LOCK, not just a floor

pnpm matches the key range against the **declared dependency spec** (intersection), then replaces
the whole spec with the fixed target. So `'hono@>=4.0.0 <4.12.27': '4.12.27'` pins hono at exactly
4.12.27 even though the natural resolution of the SDK's `^4.11.4` is 4.12.31 — the "safe floor"
reading is wrong, it is a hard pin that blocks forward movement. Verified empirically via the test
above (with overrides → 4.12.27, without → 4.12.31).

**How to apply:** for every no-op override, check `pnpm view <pkg> version` against the target. A
target below the naturally-resolved version is a defense-in-depth regression and should be flagged,
not waved through as "harmless because it's already patched".

Related: [[project-npm-files-exposure]]
