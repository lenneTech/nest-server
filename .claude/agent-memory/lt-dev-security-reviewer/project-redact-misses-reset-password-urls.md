---
name: project-redact-misses-reset-password-urls
description: FIXED in 11.36.1 — redactSensitiveText did not mask `/reset-password/<token>` (only `?token=`), so a logged Better-Auth reset URL reached the ADMIN Hub panel verbatim. Do not re-report; the probe below now proves the fix.
metadata:
  type: project
---

**STATUS: FIXED in 11.36.1. Do not re-report.** Kept because the SHAPE of the defect recurs and the
probe is the cheap way to check a neighbouring function.

## What the defect was

`redactSensitiveText()` (`src/core/common/helpers/logging.helper.ts`) had a path-segment rule whose
alternation was `verify|reset|confirm|activate|invite|magic-?link|set-password|change-email` followed
by a literal `/`. Better-Auth's reset URL is `<baseURL>/iam/reset-password/<token>?callbackURL=` —
`reset` is followed by `-password`, not `/`, so **nothing in the function matched it**. There was
also no `token=` in that URL (the token is a path segment), so the key/value rule missed it too.

The email-VERIFICATION URL was the opposite: it carries `?token=<...>` and WAS masked. The two
auth-mail URLs had opposite redaction outcomes despite looking symmetric — which is exactly why
nobody noticed.

**Why it mattered:** `HubLogBufferService` pipes every NestJS `Logger` record through
`redactSensitiveText` before the ring buffer, and `CoreHubMailboxService` does the same for captured
mail. Both are served at ADMIN-gated `/hub`. So any `logger.*` call carrying a reset URL landed in an
HTTP-readable buffer in full — a bearer capability for account takeover, mintable on demand by an
unauthenticated caller via `POST /iam/request-password-reset`.

## The fix

The alternation now leads with the compound spellings:
`request-password-reset|reset-password|forget-password|forgot-password|set-password|change-email|magic-?link|verify|reset|…`.
Order is load-bearing — alternation is first-match, so `reset-password` must precede `reset`.

11.36.1 also removed the two callers that put a reset URL into a logger at all
(`core-better-auth.module.ts` fallback branches now report the failure, not the capability), so this
rule is defense in depth rather than the only barrier.

## Probe (still the right way to check — the regex backtracks, ordering intuition is unreliable)

```bash
node_modules/.bin/tsx -e "import {redactSensitiveText} from './src/core/common/helpers/logging.helper';
console.log(redactSensitiveText('https://api.x/iam/reset-password/JnQ2K8xL5pR7wT1vB4hZ9mCd?callbackURL='))"
```

Expected NOW: `.../reset-password/JnQ2...9mCd?callbackURL=`. An unmasked token means the fix was
reverted.

## The lesson worth keeping

A redaction rule is only as good as its knowledge of the URL shapes the app actually emits. When a
new auth route is added, re-run the probe against ITS url — do not assume the family is covered.

Related: [[project-hub-config-masking-gaps.md]] is the same class of defect in a DIFFERENT function
(`maskConfigDeep`) and is **not** fixed — do not assume a fix in one covers the other.
