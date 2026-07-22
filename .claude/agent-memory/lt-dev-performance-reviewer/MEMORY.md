# lt-dev Performance Reviewer Memory

## Project
- [AI Module Performance Profile](ai-module-perf.md) — per-prompt DB query budget + memory characteristics of src/core/modules/ai; what to re-check vs what's already correct.
- [Hub Module Performance Profile](hub-module-perf.md) — admin cockpit: verified zero-cost gating + single-poller model; the 5 low-severity findings to re-check as it evolves.

## Build & Startup
- [SWC/CJS TDZ + CI Gap](swc-cjs-tdz-and-ci-gap.md) — circular-import crashes hit `nest start -b swc` but NOT CI (vitest's unplugin-swc misses it); includes the cycle-triage rule.

## Memory & Process
- [Heap Ceiling + Sync stderr](heap-ceiling-and-sync-stderr.md) — measured: `--max-old-space-size=4096` is a no-op on 32GB hosts; bare `node` in prod is correct (cgroup auto-sizing); `writeSync(2)` blocks forever on a stalled pipe.
