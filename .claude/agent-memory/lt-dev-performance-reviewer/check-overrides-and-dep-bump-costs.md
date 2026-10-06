---
name: check-overrides-and-dep-bump-costs
description: Measured 2026-10-06 — check-overrides cost per run in all four copies (own pnpm audit, registry spawn, GitHub lookups), outage stall + error-envelope false green, pnpm 11.14 registry env behaviour, simple-git 4 patch; nodemailer/proxy-addr/MCP non-regressions.
metadata:
  type: project
---

Measured during the 11.42.4/11.42.5 review and wave 2b (2026-10-06). None of these was a High perf regression. Re-measure only if the code named here changes.

- **check-overrides.mjs residual checks** (`resolvedVersions` / `dependentsOf`, byte-identical in nest-server, nest-server-starter, lt-monorepo and nuxt-base-template): the lockfile is read ONCE at module load. Measured ~4 ms (turbo, 1.15 MB), ~1.3 ms (template, 0.44 MB) per `dependentsOf` call; `resolvedVersions` ~0.5 ms. They run only per DECLARED `unusableFixConsumers` entry per affected package.
- **check-overrides per-run cost, standalone** (warm network, token set): ~1.2-2.1 s total = its OWN `pnpm audit --json` (0.5-1.1 s; it does not reuse the chain's audit) + `pnpm config get registry` spawn (0.27-0.55 s, evaluated EAGERLY at top level even when the bulk probe is skipped) + concurrent GitHub lookups (~0.4-0.5 s for 2). The chain's own `pnpm audit` is 0.8-1.0 s. Only an all-zero raw tally makes the probe run; suppressed advisories still count in `metadata.vulnerabilities`, so a tree with suppressions never probes.
- **Generated monorepo:** lt CLI hoists the app's pnpm config to the root, so the app's copy early-exits ("no overrides and no suppressions") in 60-200 ms with no spawn or fetch.
- **Registry unreachable** (`pnpm_config_registry=http://127.0.0.1:9/`): pnpm 11.14 `audit` stalls ~71 s on fetch retries, then prints `{"error":{"code":"pnpm","message":"fetch failed"}}`. Every guard copy accepts that envelope as a report (`report.advisories` undefined skips the ambiguity probe) and prints "ok — N override(s) checked", a false green. Every `check` run during an outage pays the stall twice (chain audit plus guard audit).
- **pnpm 11.14.0 registry env:** `npm_config_registry` is IGNORED by both `pnpm audit` and `pnpm config get registry`, while `pnpm_config_registry` is honoured by both. The env-first lookup in `configuredRegistry()` reads the variable pnpm 11 ignores.
- **simple-git 4.0.2 patch** (default-export restore for @nuxt/devtools): the import costs 21-55 ms, the same as 3.36.0. Applying the patch is a one-time ~tens of ms per store entry.
- **Measurement gotcha:** `pnpm exec` in nuxt-base-template triggers a full install plus `nuxt prepare` and `simple-git-hooks` (verify-deps-before-run). Probe env vars with a plain `node` script instead.
- **nodemailer 10.0.14**: addressparser and `parseHeaderValue` scale linearly up to 80k-char adversarial input. A normal parse costs ~5-6 us per send.
- **proxy-addr 2.0.8**: ~1-5 us per trust evaluation, the same as 2.0.7.
- **TestHelper `mcp()` / `mcpSession()`**: no timers or handles of their own. Unclosed sessions are bounded by `CoreAiMcpController` (25 per user, 500 total, LRU).

**How to apply:** treat these as answered unless the named function, version, or session cap changed. See also [[config-service-get-cost]] for the measurement style.
