# lt-dev Performance Reviewer Memory

## Project
- [AI Module Performance Profile](ai-module-perf.md) — per-prompt DB query budget + memory characteristics of src/core/modules/ai; what to re-check vs what's already correct.

## Build & Startup
- [SWC/CJS TDZ + CI Gap](swc-cjs-tdz-and-ci-gap.md) — circular-import crashes hit `nest start -b swc` but NOT CI (vitest's unplugin-swc misses it); includes the cycle-triage rule.
