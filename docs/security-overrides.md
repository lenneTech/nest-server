# Security Overrides — and why yours are not inherited

## The problem in one sentence

**pnpm `overrides:` apply only to the ROOT project of an install.** The overrides declared in
`@lenne.tech/nest-server`'s own `pnpm-workspace.yaml` therefore do **not** travel with the published
package. Your project resolves its own dependency tree with *your* overrides — which, by default,
are none.

A green `pnpm audit` inside the framework repo says nothing about your tree.

## What this concretely means for you

The framework pulls in four transitive packages that its `@nestjs/*` dependencies exact-pin, or
used to **exact-pin**, to a vulnerable version:

| Package | Advisory | Why it cannot resolve forward on its own |
|---------|----------|------------------------------------------|
| `ws` | [GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p) — high: memory-exhaustion DoS + uninitialized memory disclosure. Patched `>=8.21.0` | Older `@nestjs/graphql` releases declare `"ws": "8.20.1"` — an **exact pin**, not a caret. 13.4.5 pins `8.21.3`; 14.0.3, the version this framework declares since 12.0.0, pins `8.22.0` |
| `js-yaml` | [GHSA-pm4m-ph32-ghv5](https://github.com/advisories/GHSA-pm4m-ph32-ghv5) — high: exponential parsing time in flow collections (DoS), patched `>=5.2.2`; [GHSA-r3ph-w7gj-g6xm](https://github.com/advisories/GHSA-r3ph-w7gj-g6xm) — moderate: `maxTotalMergeKeys` does not bound CPU use for empty merge sources, covers `<=5.4.0`, patched `>=5.4.1` (published 2026-09-29) | `@nestjs/swagger` declares js-yaml as an **exact pin**, the same shape as the `ws` case: older releases `5.2.1`, 11.4.7 — the newest 11.x — `5.3.0`, which no 11.x update moves, so the entry is **load-bearing on @nestjs/swagger 11**. 12.0.3, the version this framework declares since 12.0.0, pins `5.5.0`, which clears both advisories: on @nestjs/swagger 12 the entry is inert |
| `@graphql-tools/utils` | [GHSA-7mx3-vvmw-hjmv](https://github.com/advisories/GHSA-7mx3-vvmw-hjmv) — high: prototype pollution in `mergeDeep`, which runs while the GraphQL schema is assembled. Covers `<=12.0.0`, patched `>=12.0.1` (added 2026-10-06); [GHSA-c4qx-w738-7hr3](https://github.com/advisories/GHSA-c4qx-w738-7hr3) — high: prototype pollution in `mergeIncrementalResult` via non-primitive path segments. Covers `>=10.10.1 <=12.0.1`, patched `>=12.0.2` (published 2026-10-22) | `@nestjs/graphql` declares utils as an **exact pin**: 13.4.5 — the newest 13.x — `12.0.0`, and 14.0.3, the version this framework declares since 12.0.0, `12.0.1`. 12.0.1 clears the first advisory and is covered by the second, so **this entry is load-bearing on both majors**. `@apollo/server` reaches utils too, through `@graphql-tools/schema` / `merge` — and in a lockfile that still holds schema 10.0.x (resolved before 2026-08-12), as **utils 11.x**: vulnerable too, with no 11.x fix, and outside the override key. Lift it with `pnpm update --depth Infinity @graphql-tools/schema @graphql-tools/merge`; the current releases request utils `^12.1.0`, which needs Node >=22.15 — the framework's own floor since 11.42.10 |
| `multer` | [GHSA-wc9g-mqfw-jrwm](https://github.com/advisories/GHSA-wc9g-mqfw-jrwm), [GHSA-535w-7cp7-47q4](https://github.com/advisories/GHSA-535w-7cp7-47q4), [GHSA-qfvm-cv95-jqjf](https://github.com/advisories/GHSA-qfvm-cv95-jqjf) — high: DoS via crafted multipart input; [GHSA-qvfw-j98x-7q72](https://github.com/advisories/GHSA-qvfw-j98x-7q72) — low: file size limit bypass. Patched `>=2.3.0`; [GHSA-q7qp-rjg7-q26m](https://github.com/advisories/GHSA-q7qp-rjg7-q26m) — high: DoS via a pending asynchronous `fileFilter` after request teardown. Covers `>=2.0.0 <2.5.0`, patched `>=2.5.0` (published 2026-10-22) | `@nestjs/platform-express` declares multer as an **exact pin**: up to 11.2.5 `2.2.0`, 11.2.6 / 11.2.7 `2.4.0`, and so does 12.2.0 — the version this framework declares since 12.0.0, and the newest 12.x. 2.4.0 is covered by GHSA-q7qp-rjg7-q26m, so **this entry is load-bearing again**. A direct `multer` dependency does not move the pin: you get both copies, and FileInterceptor uses the vulnerable one |

**Status since 12.0.0** (`@nestjs/*` 12, verified 2026-10-24): `multer` is load-bearing again
(GHSA-q7qp-rjg7-q26m covers the `2.4.0` that `@nestjs/platform-express` 12.2.0 pins) and so is
`@graphql-tools/utils` (GHSA-c4qx-w738-7hr3 covers the `12.0.1` that `@nestjs/graphql` 14.0.3 pins);
`js-yaml` is inert, because `@nestjs/swagger` 12.0.4 pins the patched `5.5.0`. Three further
advisories from the same weeks need **no override**, because every requester's range already reaches
the fix — but an existing lockfile keeps the old version until it is refreshed:
`body-parser` 2.4.0 (GHSA-27r3-jxmh-p828, high), `fast-uri` 3.1.9 (four advisories, up to moderate)
and `zod` 4.6.6+ (GHSA-mrhx-c7xc-m3w5, high):
`pnpm update --depth Infinity body-parser fast-uri zod`. If your own `pnpm-workspace.yaml` carries an
entry for one of them, raise its key and target instead — an entry whose target sits below the fix
pins the vulnerable version in place.

**Status since 11.42.4:** `@graphql-tools/utils` joins `js-yaml` as load-bearing — no `@nestjs/graphql`
13.x resolves past the exact pin. The 11.42.4 release also covers `proxy-addr` (GHSA-jqcg-44mw-7w3h,
critical: IP spoofing through an IPv4-mapped IPv6 address in a trusted subnet — it is what
`trustProxy` hands to Express). That one needs **no override**: `express` requests `^2.0.7` and the
fix `2.0.8` is in range, but an existing lockfile keeps `2.0.7` until you refresh it:
`pnpm update --depth Infinity proxy-addr`.

**Status since 11.41.5:** `ws` and `multer` resolve to a patched version on their own with the
`@nestjs/*` versions this framework declares; their entries below are insurance for a project whose
own `package.json` pins an older `@nestjs/graphql` or `@nestjs/platform-express`. **`js-yaml` does
not**: GHSA-r3ph-w7gj-g6xm covers the `5.3.0` that `@nestjs/swagger` 11.4.7 pins, so without the
entry your `pnpm audit` reports it. Its key and target were raised in 11.41.5 — an entry copied
before that (`<5.2.2`) no longer reaches swagger's pin.

`@nestjs/graphql` is a plain `dependencies` entry, so `ws` is installed even when you run with
`graphQl: false`. `@nestjs/swagger` and `@nestjs/platform-express` are likewise plain `dependencies`
entries. None of them is optional in practice.

## The fix

Add this to your project's `pnpm-workspace.yaml` (pnpm 11+; in pnpm 10 and earlier it lives under
`pnpm.overrides` in `package.json`). On nest-server **12.x** these two entries are all it takes — a fresh
resolve of nest-server 12.0.0's own tree with and without every other former entry audits identically:

```yaml
overrides:
  # @nestjs/platform-express exact-pins multer: 2.2.0 up to 11.2.5 (GHSA-wc9g-mqfw-jrwm and three more,
  # patched >=2.3.0), 2.4.0 in 11.2.6 / 11.2.7 / 12.2.0 — GHSA-q7qp-rjg7-q26m (high, patched >=2.5.0).
  # LOAD-BEARING again since nest-server 12.0.0: the key must reach the exact 2.4.0 pin.
  # Keep the target in LOCKSTEP with the multer version @lenne.tech/nest-server declares (2.5.0 since 12.0.0).
  # Remove once @nestjs/platform-express pins >=2.5.0 itself.
  'multer@>=2.0.0 <2.5.0': '2.5.0'

  # @nestjs/graphql exact-pins @graphql-tools/utils — 13.4.5: 12.0.0 (GHSA-7mx3-vvmw-hjmv, high, patched
  # >=12.0.1); 14.0.3 (nest-server 12.0.0): 12.0.1 (GHSA-c4qx-w738-7hr3, high, patched >=12.0.2).
  # The key below reaches both pins.
  # Target the newest 12.x, so the caret requesters (@graphql-tools/schema / merge) are not held back —
  # @graphql-tools/schema 10.1.5 requests ^12.1.0, so a lower target leaves a second copy in the tree.
  # 12.0.2+ requires Node >=22.15 via @whatwg-node/promise-helpers@2 — the floor this framework declares
  # since 11.42.10. There is no older way out: 12.0.1 is covered by GHSA-c4qx-w738-7hr3, so a Node
  # below 22.15 has no patched utils at all — raise Node.
  # Does NOT reach a utils 11.x pulled in by an older @graphql-tools/schema 10.0.x — refresh that one instead:
  #   pnpm update --depth Infinity @graphql-tools/schema @graphql-tools/merge
  # Remove once @nestjs/graphql pins >=12.0.2 in the major you use.
  '@graphql-tools/utils@>=12.0.0 <12.1.0': '12.1.0'
```

### Only on nest-server 11.x: `ws` and `js-yaml`

`@nestjs/graphql` 13 and `@nestjs/swagger` 11 exact-pin vulnerable versions of these two; their 12.x
successors pin patched ones (`ws` 8.22.0, `js-yaml` 5.5.0). On nest-server 12 remove both entries — an
inert `ws` entry is not harmless there: pnpm rewrites `graphql-ws`'s `ws` peer range to the override
target, so a target below 8.22.0 makes `pnpm peers check` report `unmet peer ws`.

```yaml
  # nest-server 11.x only (@nestjs/graphql 13 exact-pins ws; GHSA-96hv-2xvq-fx4p, patched >=8.21.0)
  'ws@>=8.0.0 <8.21.0': '8.21.3'
  # nest-server 11.x only (@nestjs/swagger 11.4.7 exact-pins js-yaml 5.3.0; GHSA-r3ph-w7gj-g6xm, patched >=5.4.1)
  'js-yaml@>=5.0.0 <5.4.2': '5.4.2'
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

This applies while a project carries a `ws` entry at all, i.e. on nest-server 11.x. `8.22.0` (since 12.0.0;
`8.21.3` before) is not an arbitrary "latest patch" — it is the version
`@lenne.tech/nest-server` declares as an ordinary **dependency**, so it is already in your tree whether
or not you list `ws` yourself. The override target has to equal it.

Under `nodeLinker: hoisted` (what this framework and the starters use), a lower target does not
merely leave you one patch behind: it puts a **second, older `ws` copy** in the tree next to the
declared one. The transitive consumers resolve to the override target, the declared dependency stays
where its `package.json` pins it, and you now carry two `ws` versions — of which only one is visible
when you read a manifest. The target was raised `8.21.1` → `8.21.3` on 2026-08-10 for exactly this
reason, and to `8.22.0` with nest-server 12.0.0.

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
