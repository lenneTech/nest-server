---
name: project-pnpm-overrides-propagation
description: pnpm-workspace.yaml overrides do NOT reach npm consumers of @lenne.tech/nest-server; TWO confirmed exact-pin leaks (@nestjs/graphql->ws@8.20.1, @nestjs/swagger->js-yaml@5.2.1). docs/security-overrides.md is the consumer-facing list and must be updated with every new prod override. Plus the override-necessity test, the --prod triage for ignoreGhsas, and pnpm's downgrade-lock mechanic.
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

**Second confirmed case (2026-07-30, DEV-2698 review):** `@nestjs/swagger@11.4.6` — also a plain
prod `dependencies` entry — declares `"js-yaml": "5.2.1"`, again an **exact pin**. js-yaml `<=5.2.1`
is GHSA-pm4m-ph32-ghv5 (high, exponential parsing time in flow collections; verified against the npm
bulk-advisory endpoint). Same shape as `ws`, same consequence: every consumer ships it. This is now a
**pattern, not an accident** — when a new prod override appears, check `node -p "require('./node_modules/<parent>/package.json').dependencies['<pkg>']"`
for an exact pin, because that is the class that cannot self-heal.

**`docs/security-overrides.md` is the consumer-facing contract** and IS shipped (`docs/**` is in the
npm `files` array). It currently lists only `ws` + `@hono/node-server`. **Any new override on a PROD
path must be added there in the same change** — otherwise the framework's audit goes green while
every consumer stays vulnerable and has no way to learn about it. Treat a missing doc entry as the
finding, not as a nit.

**Self-healing vs. not — check the declared range before flagging.** A transitive override is only a
propagation gap when the parent's declared range cannot reach the fix. `@ts-morph/common` declares
`minimatch: ^10.0.1` and `minimatch@10.2.6` declares `brace-expansion: ^5.0.8` — a fresh consumer
install resolves those forward on its own, so those overrides are repo-local hygiene, not consumer
exposure. Only exact pins (and dead majors like the MCP SDK's `^1.19.9`) are real leaks.

**How to apply:** when reviewing any override/audit change in this repo, always ask the second
question — "does the consumer inherit the fix?" A clean `pnpm audit` here is not evidence about
downstream. Per the global "Grund-Repos" rule, the durable fix belongs in `nest-server-starter`'s
`pnpm-workspace.yaml` (the template every project starts from) and/or a shipped doc under `docs/**`
(which IS in the npm `files` array). Do not accept "pnpm audit is green" as closing the finding.

## Triaging an `auditConfig.ignoreGhsas` suppression: run `pnpm audit --prod` FIRST

`ignoreGhsas` is a **global GHSA-ID filter with no path or package scoping** — it hides the advisory
everywhere, including a future PROD occurrence of the same ID. Before accepting one that is justified
as "dev-only", run `pnpm audit --prod`. If that is already clean, the narrower instrument exists and
the global suppression is over-broad: the CI gate should be `pnpm audit --prod` (blocking) plus a
non-blocking full audit, not a permanent ID suppression. Verified 2026-07-30: `pnpm audit` reported
`1 high (1 ignored)` while `pnpm audit --prod` reported `No known vulnerabilities found`.

`pnpm why <pkg>` is the authoritative check for the "only one path remains" claim — it prints the
full chain and tags each root as `(dependencies)` or `(devDependencies)`.

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
