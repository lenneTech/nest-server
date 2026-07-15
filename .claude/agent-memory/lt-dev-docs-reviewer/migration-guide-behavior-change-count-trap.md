---
name: migration-guide-behavior-change-count-trap
description: Never trust a nest-server migration guide's own Overview counts or its "this aligns with existing pattern X" claims — derive both from the source diff and from reading every branch of X
metadata:
  type: feedback
---

When assessing whether a `migration-guides/X-to-Y.md` is COMPLETE and ACCURATE, do not trust the guide's self-description. Two traps, both confirmed by real reviews:

**Trap 1 — Overview counts under-report.** Derive the true list of consumer-visible behavior changes straight from the framework-source diff, especially `src/core/modules/better-auth/better-auth.config.ts` and `src/core/common/helpers/cookies.helper.ts`, where several independent behavior changes land in one release. In the 11.27.5→11.27.6 review the guide claimed 3 behavior changes / 4 bugfixes but the code had ≥5: it omitted the `advanced.useSecureCookies: false` pin entirely (a 2FA/passkey/`/token` 401 split-brain fix WITH an opt-out) and demoted the `deriveCookieDomainFromUrls()` bare-TLD guard to an export aside. Fast cross-check: every new `tests/unit/*` behavior spec should map to a documented guide entry.

**Trap 2 — "aligns with existing pattern X" claims are only spot-checked.** When a guide justifies a breaking change as *"we are just aligning with what X already did"*, read EVERY branch of X, not the one the guide quotes. In the 11.27.6→11.28.0 review the guide claimed the new service-layer 401/403 split "aligns with the existing `RolesGuard` pattern" and listed RolesGuard under "What is NOT affected". True for the role-mismatch branch (`!user` → 401, user-lacks-role → 403) — but **false for the `S_NO_ONE` branch**: `roles.guard.ts` and `better-auth-roles.guard.ts` throw `UnauthorizedException` (401) for `S_NO_ONE` even when authenticated, while `core-tenant.guard.ts` throws `ForbiddenException` (403) and the newly changed `check()` now also throws 403. So the release *created* a three-way split while the guide asserted alignment.

Related sub-trap: check whether the aligned-with pattern also carries an **ErrorCode** that the new code drops. RolesGuard throws `ForbiddenException(ErrorCode.ACCESS_DENIED)` (`LTNS_0101`, has a German translation); the new `AccessDeniedException` sites throw raw strings with no `#LTNS_xxxx:` marker, so `useLtErrorTranslation()` cannot translate them — while the guide simultaneously says "ErrorCodes — unchanged" and recommends the error-translation layer as the remedy.

**How to apply:** For each `+`-added behavior in the diff, grep the guide for a matching keyword. A behavior change present in code but absent from the guide's "Behavior changes" section AND its opt-out is a High-priority finding. For every "already behaves like X" / "unchanged" claim, open X and enumerate its branches. See [[doc-surfaces-for-config-features]].
