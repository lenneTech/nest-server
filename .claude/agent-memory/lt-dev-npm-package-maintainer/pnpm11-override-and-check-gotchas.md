---
name: pnpm11-override-and-check-gotchas
description: pnpm 11 override-key semantics, lockfile stickiness after an override edit, and why `pnpm run check --no-fix` is the safe form when the tree has uncommitted src/ work
metadata:
  type: feedback
---

Three tool behaviours that cost time in the lt stack (nest-server + nest-server-starter,
pnpm 11, `scripts/check.mjs`). All verified 2026-08-22 on pnpm 11.13.1.

**1. An override key is matched against the REQUESTED RANGE, not the resolved version.**
So `ip-address@<10.3.1` still fires for a consumer asking `^10.0.0` and pins the whole tree
to the target. There is no "floor-only" override — every entry is a hard pin, and a target
left behind the newest release in its major is a silent downgrade lock. A *bare* key
(`hono: 4.12.25`) matches every range, so a bare + a ranged rule for the same package fight
and the loser is invisible.
**Why:** in the starter this produced `'@hono/node-server': 1.19.14` (below the CVE fix)
sitting next to `'@hono/node-server@<2.0.10': 2.0.11` (above it) — audit green, config
contradictory. Same shape had already bitten `fast-uri`.
**How to apply:** one rule per package (per major line is fine, e.g. ws 7.x/8.x). The only
honest test is TWO FRESH `--lockfile-only` resolves, one with the `overrides:` block and one
without, then diff the resolved versions — diffing against the committed lockfile proves
nothing, it already carries the pins. Procedure is now written up in the starter's
`SECURITY.md` → "Verifying an override is still doing something".

**2. `pnpm install` after editing overrides does NOT re-resolve everything.**
It keeps existing lockfile entries that still satisfy the ranges, so a raised/removed
override can leave the old version in place (`@hono/node-server` stayed 2.0.11 when a fresh
resolve gives 2.1.1). Fix with a targeted `pnpm update --depth Infinity <pkg> [<pkg>...]`.
Do NOT swap in the fresh-resolve lockfile wholesale — it also drifts unrelated transitives
(kysely 0.28→0.29, nanostores 1.3→1.5 in one run), which is a much bigger, unreviewed change.

**3. `pnpm run check` auto-fixes format + lint by default — it WRITES to `src/` and `tests/`.**
When the working tree carries uncommitted source work (a release in progress), run
`pnpm run check --no-fix` (read-only gate, same exit-code contract). It also runs
`spectaql:sync`, which legitimately rewrites `spectaql.yml`'s version from `package.json` —
expect that file in the diff on a release run.

## Proving an override is a downgrade lock (technique, verified 2026-08-22 in lt-monorepo)

A pnpm override key matches the **requested range**, not the resolved version — so a
bounded key pins rather than floors. Probe that directly instead of assuming: add a key
whose window the natural resolve does NOT satisfy (e.g. `'fast-xml-parser@<5.6.0': '5.9.0'`
where the parent asks `^5.5.6` and the tree resolves 5.11.0). If it fires, the key is
matched against the parent's declared range.

The load-bearing test is **two fresh `--lockfile-only` resolves** from the same
`package.json` in a scratch dir — one with `overrides:`, one with it stripped — then diff
resolved versions and `pnpm audit` both. Strip `auditConfig.ignoreGhsas` in a third control,
or a stale suppression hides the answer. Diffing against the COMMITTED lockfile proves
nothing: it already carries the pinned versions.

After changing an override, `pnpm install` alone keeps the stale entry ("Already up to date").
`pnpm update <pkg>` moves that package but leaves its transitives stale; only
`rm -rf node_modules pnpm-lock.yaml && pnpm install` yields a lockfile equal to a clean-room
resolve. Verify by diffing the repo lockfile against a scratch `--lockfile-only` resolve.

Also: an `auditConfig.ignoreGhsas` entry justified as "upstream range was never narrowed"
must be re-checked against the live advisory — GitHub narrowed GHSA-mh99-v99m-4gvg to
per-major windows, which silently made the suppression obsolete.
