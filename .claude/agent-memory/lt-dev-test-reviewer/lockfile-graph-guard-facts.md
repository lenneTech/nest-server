---
name: lockfile-graph-guard-facts
description: When reviewing a guard that walks pnpm-lock.yaml v9 to find "who depends on X" — direct/workspace deps live under importers:, not snapshots:, and their edge lines end at the colon; a synthetic-lockfile probe proves the gap in seconds
metadata:
  type: reference
---

pnpm lockfile v9 order: `importers:` → `packages:` → `snapshots:`. A guard that scans only from
`snapshots:` (as `dependentsOf()` in `scripts/check-overrides.mjs` did on 2026-10-06 for the
`unusableFixConsumers` second-consumer check) sees transitive parents but is BLIND to the project's
own `dependencies` and to every workspace package (`projects/app:`). Those are the likeliest
production-closure parents, so the blind spot is a false green, not noise.

Second trap in the same spot: an importer edge is written as
`      simple-git:` with `specifier:` / `version:` on the next lines (nothing after the colon), while
a snapshot edge is `      simple-git: 3.36.0`. An edge regex ending in `:\s` cannot match the
importer form even if the scan range is widened. Peer edges (`peerDependencies:` in `packages:`,
`transitivePeerDependencies:`) must stay excluded.

**How to apply:** for any lockfile-walking guard, build a scratchpad workspace (copy the script,
write package.json + pnpm-workspace.yaml + a hand-written v9 lockfile + `--audit-file` /
`--advisory-file` fixtures, run with `CI=`), and probe three parent shapes: snapshot parent (control),
root importer, workspace importer. Exit codes from zsh pipes are lost (`PIPESTATUS` is bash) — rerun
without the pipe. Related: [[scratch-copy-mutation-check]], [[check-gate-coverage-blind-spots]].
