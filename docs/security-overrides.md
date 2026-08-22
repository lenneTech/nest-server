# Security Overrides — and why yours are not inherited

## The problem in one sentence

**pnpm `overrides:` apply only to the ROOT project of an install.** The overrides declared in
`@lenne.tech/nest-server`'s own `pnpm-workspace.yaml` therefore do **not** travel with the published
package. Your project resolves its own dependency tree with *your* overrides — which, by default,
are none.

A green `pnpm audit` inside the framework repo says nothing about your tree.

## What this concretely means for you

The framework pulls in two transitive packages that resolve to a **vulnerable** version unless you
override them yourself:

| Package | Advisory | Why it cannot resolve forward on its own |
|---------|----------|------------------------------------------|
| `ws` | [GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p) — high: memory-exhaustion DoS + uninitialized memory disclosure. Patched `>=8.21.0` | `@nestjs/graphql` declares `"ws": "8.20.1"` — an **exact pin**, not a caret. No amount of updating moves it |
| `js-yaml` | [GHSA-pm4m-ph32-ghv5](https://github.com/advisories/GHSA-pm4m-ph32-ghv5) — high: exponential parsing time in flow collections (DoS). Patched `>=5.2.2` | `@nestjs/swagger` declares `"js-yaml": "5.2.1"` — an **exact pin**, the same shape as the `ws` case. It cannot resolve forward |

`@nestjs/graphql` is a plain `dependencies` entry, so `ws` is installed even when you run with
`graphQl: false`. `@nestjs/swagger` is likewise a plain `dependencies` entry. Neither is optional in
practice.

## The fix

Add this to your project's `pnpm-workspace.yaml` (pnpm 11+; in pnpm 10 and earlier it lives under
`pnpm.overrides` in `package.json`):

```yaml
overrides:
  # @nestjs/graphql exact-pins ws@8.20.1 (GHSA-96hv-2xvq-fx4p, high, patched >=8.21.0).
  # An exact pin cannot resolve forward — the override is the only fix.
  # Keep the target in LOCKSTEP with your direct `ws` dependency (see the note below).
  # Remove once @nestjs/graphql stops pinning it.
  'ws@>=8.0.0 <8.21.0': '8.21.3'

  # @nestjs/swagger exact-pins js-yaml@5.2.1 (GHSA-pm4m-ph32-ghv5, high, patched >=5.2.2).
  # Same shape as the ws entry: an exact pin cannot resolve forward.
  # Remove once @nestjs/swagger stops pinning it.
  'js-yaml@>=5.0.0 <5.2.2': '5.2.2'
```

### Retired: `@hono/node-server` (removed 2026-08-22, nest-server 11.36.1)

This list used to carry a third entry. `@modelcontextprotocol/sdk` declared `@hono/node-server@^1.19.9`
with no 1.x fix line, so reaching the patched version needed a deliberate cross-major override.

SDK `1.30.0` declares `"^1.19.9 || ^2.0.5"`, so a fresh resolve now picks the newest 2.x (2.1.1 at the
time of writing) on its own — above the `>=2.0.10` that fixes GHSA-frvp-7c67-39w9 and
GHSA-9mqv-5hh9-4cgg. The override became a **downgrade lock**: an override key is matched against the
REQUESTED RANGE, not the resolved version, so the entry replaced the SDK's whole spec and pinned the
tree to `2.0.11` even though nothing needed help any more.

**Do not re-add it** unless the SDK narrows its range again. If you still carry it in your own
`pnpm-workspace.yaml`, remove it and re-run `pnpm audit`.

### The `ws` target must stay in lockstep with the declared `ws` version

`8.21.3` is not an arbitrary "latest patch" — it is the version `@lenne.tech/nest-server` declares as
an ordinary **dependency**, so it is already in your tree whether or not you list `ws` yourself.
The override target has to equal it.

Under `nodeLinker: hoisted` (what this framework and the starters use), a lower target does not
merely leave you one patch behind: it puts a **second, older `ws` copy** in the tree next to the
declared one. The transitive consumers resolve to the override target, the declared dependency stays
where its `package.json` pins it, and you now carry two `ws` versions — of which only one is visible
when you read a manifest. The target was raised `8.21.1` → `8.21.3` on 2026-08-10 for exactly this
reason.

**Rule:** whenever the `ws` version declared by `@lenne.tech/nest-server` (or by your own
`package.json`, if you list it) moves, move this override target with it in the same commit. The
same applies to any other override whose package also appears as a declared dependency.

Then:

```bash
pnpm install
pnpm audit          # must report no known vulnerabilities
pnpm test           # nothing should regress
```

Commit `package.json`/`pnpm-workspace.yaml` **and** `pnpm-lock.yaml` together.

> Projects generated from `nest-server-starter` or `lt-monorepo` already carry all three entries.
> This page is for projects that predate that, or that were assembled by hand.

## Rules for writing your own overrides

These are the same rules the framework applies to itself
(`.claude/rules/package-management.md`):

1. **The target must be a fixed version.** Never `>=x`, `^x`, `~x`, `*`. An unbounded target lets
   pnpm install the newest match, which can silently cross a major version. This is not
   hypothetical — an override written as `'vite@>=7.0.0 <=7.3.1': '>=7.3.2'` resolved to `vite@8.0.8`
   and broke peer dependencies across three packages.

2. **Prefer a bounded key.** `'pkg@>=2.0.0 <2.1.2': '2.1.2'` leaves non-vulnerable versions alone
   and limits the blast radius. `'pkg': '2.1.2'` replaces *every* version in the tree.

3. **Floor the key inside the major you mean.** A key like `'brace-expansion@>=3.0.0 <5.0.7'` also
   matches a future 3.x or 4.x dependency and would force it across two majors. Write `>=5.0.0`.

4. **An override is a hard pin, not a floor.** pnpm replaces the whole matched spec with your
   target. `'hono@>=4.0.0 <4.12.27': '4.12.27'` does not mean "at least 4.12.27" — it pins to
   exactly that, holding the package back from later patches. Remove an override as soon as the
   package resolves patched on its own; otherwise today's fix is tomorrow's downgrade-lock.

5. **Document each entry**: the advisory, which package pulls the vulnerable version in, and the
   condition under which the entry can be deleted.

6. **Verify it is load-bearing.** Resolve a lockfile with the entry removed. If the package still
   lands on a patched version, the override is inert — keep it only deliberately, and re-check it
   every maintenance run.

## Related

- [`.claude/rules/package-management.md`](../.claude/rules/package-management.md) — fixed-version
  policy, the pnpm pin contract, and the incident behind rule 1
- `pnpm-workspace.yaml` in this package — the framework's own annotated override block
