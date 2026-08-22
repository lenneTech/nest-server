---
name: project-check-mutations-tooling-risks
description: check-mutations.mjs — all three original risks (self-defeating race guard, --since option injection, empty selection exits 0) were FIXED in 11.36.3; keeps the probes plus the one residual ordering window
metadata:
  type: project
---

`scripts/check-mutations.mjs` writes into `src/` and restores afterwards, so a fail-open path in it
is worse than in ordinary tooling — it is the repo's evidence gate against vacuous tests.

**All three originally recorded risks are FIXED as of 11.36.3. Do NOT re-report them.** Verified
2026-08-22 by reading the code and re-running the probes:

1. **Race guard no longer defeats itself.** An `applied` flag gates the `finally` restore, and the
   mid-run-change branch RETURNS (was: threw into the restoring `finally`) after
   `originals.delete(file)`. A concurrent edit now survives.
2. **`--since` is no longer option-injectable.** Resolved through
   `git rev-parse --verify --quiet <ref>^{commit}`, required to match `/^[0-9a-f]{40}$/`, then passed
   to `git diff` as the SHA with a trailing `--`.
3. **Empty selection exits 2**, not 0.

Probe that distinguishes old from new (run in a throwaway `git init` dir with a sentinel file):

```
OLD: spawnSync('git',['diff','--name-only','--output=victim.txt'])  -> victim TRUNCATED, status 0
NEW: spawnSync('git',['rev-parse','--verify','--quiet','--output=victim.txt^{commit}'])
     -> status 1, sha fails the 40-hex test, script exits 1. victim intact.
```

Also verified safe, so do not raise them:
- `rmSync(dir, {recursive:true})` does **not** follow the `node_modules` symlink into a lane
  worktree — the real `node_modules` survives (tested directly).
- `--id=` is only string-compared against registry ids; no injection surface.
- `spawn()` uses the absolute `node_modules/.bin/vitest` path, no shell — a hardening over `npx`,
  which can fetch a missing package from the registry.
- `--jobs` capped at 8 and `LT_E2E_MAX_RUNS` raised only via `Math.max`, which bounds the
  MACHINE-WIDE slot dir shared with every other lt project.
- `--since` / `--no-infra` are NOT wired into the publish path (`publish.yml` runs `check:mutations`
  bare), and `specEnv()` sets `NODE_ENV: unit ? 'test' : 'e2e'` — so the e2e NODE_ENV trap does not
  apply here.

**One residual, INFO only:** `originals.set(file, original)` still runs BEFORE the race check, so a
signal delivered in that one-`readFileSync` window restores a snapshot over a concurrent edit that
was never mutated. Pre-existing ordering, tiny window.

**How to apply:** re-verify point 1 whenever the restore/worktree logic is touched; otherwise treat
this file as "already audited, clean".

Related: [[project-e2e-node-env-trap]]
