---
name: project-cross-section-pin-alignment
description: 11.42.15 (DEV-3616) — check:consumer alignConsumerPins() and the starter's extras/align-package-versions.mjs share RAISE_SOURCES; framework dependencies raise either consumer section, framework devDependencies only consumer devDependencies (better-auth stays consumer-owned).
metadata:
  type: project
---

Since 11.42.15 the consumer gate (`scripts/check-consumer.mjs` → `alignConsumerPins()`) and the
starter's `pnpm run update` rule (`extras/align-package-versions.mjs`, called by `extras/sync-packages.mjs`)
raise a pin in the section the consumer keeps it, taking the framework version from `RAISE_SOURCES`:
consumer `dependencies` ← framework `dependencies` only; consumer `devDependencies` ← newest of both.

A first version raised from BOTH framework sections into either consumer section. Review caught that
this would let nest-server's DEVdependency pins (the better-auth trio: its test versions, the peer range
is the contract) drive a project's RUNTIME better-auth — api raised on `pnpm run update`, app (whose
nuxt-base-starter pins better-auth 1.7.7 in its own `dependencies`) left behind. Repo owner chose the
restricted rule on 2026-10-14. Pinned by mutation `consumer-gate-devdeps-drive-runtime-pins`.

Verified: gate == starter on all three real manifest pairings and 0 divergences over 50k random
exact-pin cases. The two DO still differ on non-exact consumer pins (gate leaves ranges/prereleases
alone, starter raises a range the framework version lies above) — unreachable while neither manifest
has a non-exact entry. Re-check that precondition, not the code, if a future diff adds a range.

**Why:** the reverse direction (framework devDep → consumer runtime dep) is exactly the change that
looks harmless in a diff and splits api/app better-auth versions one release later.

**How to apply:** flag any edit that widens `RAISE_SOURCES.dependencies` or lets the two copies drift.
The lt CLI vendor converter deletes `extras/sync-packages.mjs` on convert-back when it contains
`vendor mode` / `vendor:sync` — any future edit to the extras files must keep those strings out (grep).
Related: [[project_api-token-module]].
