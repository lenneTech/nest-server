---
name: migration-guide-behavior-change-count-trap
description: When reviewing a nest-server migration guide, enumerate behavior changes from the better-auth.config.ts / cookies.helper.ts diff directly — the guide's Overview counts have under-reported before
metadata:
  type: feedback
---

When assessing whether a `migration-guides/X-to-Y.md` is COMPLETE, do NOT trust the guide's own Overview "Bugfixes"/"Behavior Changes" counts. Derive the true list of consumer-visible behavior changes straight from the framework-source diff — especially `src/core/modules/better-auth/better-auth.config.ts` and `src/core/common/helpers/cookies.helper.ts`, which are large files where multiple independent behavior changes land in one release and are easy to miss.

**Why:** In the 11.27.5→11.27.6 review, the guide documented 3 behavior changes and 4 bugfixes but the code had ≥5: it omitted the `advanced.useSecureCookies: false` pin entirely (a BetterAuth 2FA/passkey/`/token` 401 split-brain fix WITH an opt-out via `betterAuth.options.advanced.useSecureCookies`) and only mentioned the `deriveCookieDomainFromUrls()` `api.dev` bare-TLD guard as an export aside, not as a behavior change. Each of these had its own regression test (`tests/unit/better-auth-secure-cookies.spec.ts`) — so a fast completeness cross-check is: every new `tests/unit/*secure*`/behavior spec should map to a documented guide entry.

**How to apply:** For each `+`-added behavior in the config/helper diffs, grep the guide for a matching keyword (e.g. `useSecureCookies`, `__Secure`, the changed function name). A behavior change present in code but absent from the guide's "Behavior changes" section AND its opt-out is a High-priority finding. Also re-check the guide's numeric counts ("Three consumer-visible shifts") against the actual count. See [[doc-surfaces-for-config-features]] for the full doc-surface set.
