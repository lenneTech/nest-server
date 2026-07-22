---
name: hub-module-perf
description: Performance profile of src/core/modules/hub (admin cockpit) — verified zero-cost gating + single-poller model, plus the low-severity findings to re-check as the module evolves.
metadata:
  type: project
---

# Hub module (`src/core/modules/hub`) performance profile

Static review of the Hub admin cockpit (new, first landed uncommitted on `develop` ~2026-07). Verdict: well-engineered, ~93%. No Critical/High findings. Captured here so a future perf re-review can skip what's already verified and focus on what's still open.

**Why:** the Hub adds hot-path hooks (trace middleware on every request, log override on every log, query profiler on every mongo command) + browser polling — exactly the shape that regresses silently. **How to apply:** re-check the "still open" list below on any hub change; treat the "verified correct" list as settled unless the relevant file changed.

## Verified correct — do NOT re-litigate unless the file changed
- **Zero-cost when disabled is real.** `production` + `test` envs have NO `hub` block → `isHubEnabled()` false → module never registered. Gating chain: module-level (isHubEnabled), per-collector inert (resolve*Collector → false), `monitorCommands` opt-in only via `isHubQueriesEnabled` (respects explicit consumer `false`), trace middleware bound only when traces on (`CoreHubModule.traceEnabled` gate in `configure()`), log override early-returns when logs off, EmailService capture hook `@Optional()` (undefined = one `if` skip).
- **Idle collectors hold no buffer memory** — `new HubRingBuffer` is inside each collector's enabled-guard (except mailbox, which is only *provided* when enabled).
- **Ring buffer** (`hub-ring-buffer.ts`): O(1) append via `seq % capacity`, no Array.shift, fixed memory, **no server-side timers anywhere in the module** (all timers are client-side JS). pending Map bounded 1000 w/ oldest-first eviction. Caps: log msg 2048, cmd-shape 512, profiler errorMessage 300, stack 2000.
- **Single-active-poller** is the key polling property (non-obvious, emerges from `render()` AND `poll()` both calling `stopPoll()` in `hub-client-js.helper.ts`). Only the currently-viewed panel polls → total load = 1 req / interval (5s; 2s logs) per open tab. + pause-on-hidden + exp backoff to 60s.
- **config.json / models / error-codes / emails are load-ONCE** (plain `hubFetch`, not `poll`). So `maskConfigDeep` runs per config-panel-view, NOT per poll — the "deep clone every poll" worry is unfounded. Clone is necessary+correct (config is a deep-frozen singleton; must not hand live ref to the response pipeline).
- **getVersion()** (`meta.helper.ts`) cached via module-level `cachedVersion` (undefined=unlooked, null=looked-not-found); walks ≤6 dirs once. Test asserts idempotency.
- Driver-event handlers wrapped in `safe()` (must swallow — throwing into the driver's sync `emit()` would crash the process). Trace record + email capture also try/caught.

## Still open (all Low / Low-Moderate) — re-check these
1. **db.json**: `core-hub-db.service.ts:40` runs N sequential `$collStats` (one per collection) every 5s while the DB panel is active. Cheap metadata reads but wall-clock grows with collection count. Consider bounded `Promise.all` or short-TTL cache.
2. **Profiler self-noise**: Hub's own db.json commands (`aggregate`/`dbstats`/`listcollections`) are NOT in the profiler `DEFAULT_IGNORE`, so they get recorded as queries every 5s when both features are on. (`listindexes` IS ignored.)
3. **Log redaction is unbounded by message size**: `hub-log-buffer.service.ts` runs `redactSensitiveText` (4 global regexes) on the FULL stringified message BEFORE the 2048 truncation (deliberate — a cut must not leak a secret prefix). A megabyte-sized logged object would regex the whole thing. Pre-cap input to bound worst case. Note: default `levels` exclude debug/verbose, so "verbose DEBUG logging" cost is moot with defaults (early return before redaction).
4. **Mailbox memory ~2× documented**: `maxMailSize` (256KB) is applied per-field (html AND text each in `store()`), so max ≈ capacity(100) × 2 × 256KB ≈ 51MB, not the "html + text" combined ~25MB the `hub.constants.ts` comment implies. Bounded (not a leak); mailbox is dev/test-only (capture mode forbidden in prod/staging).
5. **Sync FS on the poll path**: `core-hub-migrations.service.ts:102` does `existsSync`+`readdirSync` every 5s while the migrations panel is active. Low impact (admin-only, single-poller) but a sync call in an async handler.

Token leaf `hub.constants.ts` follows the SWC/TDZ import-free-leaf rule — see [[swc-cjs-tdz-and-ci-gap]].
