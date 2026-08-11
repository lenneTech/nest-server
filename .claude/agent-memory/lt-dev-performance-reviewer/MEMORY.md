# lt-dev Performance Reviewer Memory

## Project
- [AI Module Performance Profile](ai-module-perf.md) — per-prompt DB query budget + memory characteristics of src/core/modules/ai; what to re-check vs what's already correct.
- [Hub Module Performance Profile](hub-module-perf.md) — admin cockpit: verified zero-cost gating + single-poller model; the 5 low-severity findings to re-check as it evolves.
- [Migrate Module Performance Profile](migrate-module-perf.md) — boot/CLI-only (no HTTP path); the per-migration state save is deliberate crash-safety, do NOT flag as N+1.

## Request Path
- [Auth-gate per-request cost](auth-gate-per-request-cost.md) — the global BetterAuth middleware already authenticates PUBLIC routes; gating adds ~0 lookups, but adds a double-verify failure path and kills shared-cache eligibility.

## Build & Startup
- [SWC/CJS TDZ + CI Gap](swc-cjs-tdz-and-ci-gap.md) — circular-import crashes hit `nest start -b swc` but NOT CI (vitest's unplugin-swc misses it); includes the cycle-triage rule.

## Micro-costs (measured, reusable)
- [ConfigService.get cost](config-service-get-cost.md) — measured 152 ns/call (rfdc factory rebuilt every call); `getFastButReadOnly` is the 79 ns option. Only matters inside loops.
- [GridFS verify + stream costs](gridfs-verify-and-stream-costs.md) — COUNT_SCAN is index-only but O(chunks); connect/close ~43 ms/file; `pipe()` leaks the source on client abort; `process.exit()` truncates piped stdout at 64 KB.

## Memory & Process
- [Heap Ceiling + Sync stderr](heap-ceiling-and-sync-stderr.md) — measured: `--max-old-space-size=4096` is a no-op on 32GB hosts; bare `node` in prod is correct (cgroup auto-sizing); `writeSync(2)` blocks forever on a stalled pipe.
