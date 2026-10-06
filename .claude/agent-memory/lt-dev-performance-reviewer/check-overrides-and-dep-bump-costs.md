---
name: check-overrides-and-dep-bump-costs
description: Measured 2026-10-06 — check-overrides unusable-fix residual checks, nodemailer 10.0.13->10.0.14 parsers, proxy-addr 2.0.7->2.0.8, TestHelper MCP session bound; all non-regressions.
metadata:
  type: project
---

Measured during the 11.42.4/11.42.5 review (2026-10-06). None of these was a regression. Re-measure only if the code named here changes.

- **check-overrides.mjs residual checks** (`resolvedVersion` / `dependentsOf`): the lockfile is read ONCE at module load. Against the largest local lockfile (turbo, 1.1 MB) `dependentsOf` costs ~4-9 ms and `resolvedVersion` ~0.5 ms per call. They run only per DECLARED `auditConfig.unusableFixConsumers` entry; nest-server declares none. GitHub Advisory API calls are still one per suppressed GHSA, fetched concurrently, so the 60/h anonymous quota is unchanged.
- **nodemailer 10.0.14**: addressparser and mime-funcs `parseHeaderValue` scale linearly up to 80k-char adversarial input (brackets, quotes, nested groups, `;` runs). A normal address parse costs ~5-6 us per send, the same as 10.0.13.
- **proxy-addr 2.0.8** (CVE fix adding canonicalisation of IPv4-mapped addresses): ~1-5 us per trust evaluation, the same as 2.0.7 within noise.
- **@graphql-tools/utils 12.0.1**: `mergeDeep` gains a constant-time `__proto__`/`constructor`/`prototype` key skip. It runs on the boot path only.
- **TestHelper `mcp()` / `mcpSession()`**: these add no timers or handles of their own. A POST's SSE stream ends with its response, and supertest buffers `text/event-stream` as text. Sessions a test never `close()`s are bounded server-side by `CoreAiMcpController`: 25 per user and 500 in total, with LRU eviction and no per-session timers.

**How to apply:** treat these as answered unless the named function, version, or session cap changed. See also [[config-service-get-cost]] for the measurement style.
