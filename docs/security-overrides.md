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
| `@hono/node-server` | [GHSA-frvp-7c67-39w9](https://github.com/advisories/GHSA-frvp-7c67-39w9) (static-file path traversal) + [GHSA-9mqv-5hh9-4cgg](https://github.com/advisories/GHSA-9mqv-5hh9-4cgg) (unauthenticated memory leak). Patched `>=2.0.10` | `@modelcontextprotocol/sdk` declares `^1.19.9` and ships **no 1.x fix line**, so the fix is only available across a major |

`@nestjs/graphql` is a plain `dependencies` entry, so `ws` is installed even when you run with
`graphQl: false`. Neither package is optional in practice.

## The fix

Add this to your project's `pnpm-workspace.yaml` (pnpm 11+; in pnpm 10 and earlier it lives under
`pnpm.overrides` in `package.json`):

```yaml
overrides:
  # @nestjs/graphql exact-pins ws@8.20.1 (GHSA-96hv-2xvq-fx4p, high, patched >=8.21.0).
  # An exact pin cannot resolve forward — the override is the only fix.
  # Remove once @nestjs/graphql stops pinning it.
  'ws@>=8.0.0 <8.21.0': '8.21.1'

  # @modelcontextprotocol/sdk declares @hono/node-server ^1.19.9 with no 1.x fix line
  # (GHSA-frvp-7c67-39w9, GHSA-9mqv-5hh9-4cgg). Deliberately a CROSS-MAJOR override.
  # Verified safe: the SDK's only consumed symbol is `getRequestListener`, whose signature
  # `(fetchCallback, options?)` is unchanged in 2.x. Engines >=20 and peer hono@^4 both fit.
  # Remove once @modelcontextprotocol/sdk moves its own range to ^2.
  '@hono/node-server@<2.0.10': '2.0.11'
```

Then:

```bash
pnpm install
pnpm audit          # must report no known vulnerabilities
pnpm test           # nothing should regress
```

Commit `package.json`/`pnpm-workspace.yaml` **and** `pnpm-lock.yaml` together.

> Projects generated from `nest-server-starter` or `lt-monorepo` already carry both entries. This
> page is for projects that predate that, or that were assembled by hand.

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
