---
name: scan-secrets-and-bridge-normaliser-costs
description: Measured costs of claude-code scripts/scan-secrets.sh (--all baseline, Check 8 per added line), the denylist --print call, and how to prove the cli playwright bridge normaliser is oxfmt-idempotent.
metadata:
  type: project
---

Measured 2026-10-06 (machine load avg 12-18, so absolute numbers are inflated ~1.5-2x):

- `scan-secrets.sh --all` on claude-code (559 files) was ~57 s BEFORE Check 8 existed — the per-file
  `file`+grep forks dominate. Check 8 does not run in `--all`; a slower `--all` reading after a diff
  is load noise unless the denylist regex changed (compare `paste -sd'|'` output of file vs `--print`).
- Check 8 (`--staged`/`--range`, new proper names next to a customer cue word): linear,
  ~2 ms per added line (one `printf|grep` fork per line) + ~100 ms per cue-word line (awk + one
  `git grep` over the base tree per candidate, not deduped across lines). 482 lines → 3.3 s,
  6016 → 13.5 s, 49k-line import → 71 s. Commit size p50=52 / p90=763 added lines, so a typical
  push gains <1 s. Not High; the fix if it ever matters is one awk pass over the whole diff.
- pre-push now runs `--all` AND `--range` per ref; the `--range` file loop re-scans changed files
  already covered by `--all` (duplicate work, bounded by `--all`).
- `bun build-public-denylist.ts --print`: 20-120 ms; exits BEFORE the customer-folder scan, which only
  runs in default/`--check` mode and is one `readdirSync` level deep (~72 ms total).

cli `normaliseBridgeBlock` (dev-patches.ts): proven idempotent by running the REAL oxfmt from
`nuxt-base-starter/node_modules/.bin/oxfmt` at `{printWidth:80, singleQuote:true}` and at defaults
over a patched config, then re-running `patchPlaywrightConfig` 3x → `patched:false` each time.
The unit test only simulates oxfmt's output; the real-formatter run is the evidence. See [[cli_perf_calibration]].
