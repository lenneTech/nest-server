---
name: redaction-regex-costs
description: redactSensitiveText (logging.helper.ts) is quadratic on crafted input. Measured per-rule costs, the input caps each caller applies, and the one caller (Hub mailbox copy mode) that redacts BEFORE truncating.
metadata:
  type: project
---

Measured 2026-09-26 (Node, M-series), one `replace()` pass per rule on a crafted string.

Several rules in `redactSensitiveText()` share one shape: a prefix, then an unbounded character class,
then a literal that the class excludes. Examples are the JWT rule
`eyJ[\w-]{6,}\.` and the api-token assertion rule `…s_[A-Za-z0-9_-]{16,}\.` (11.41.4). On input that
repeats the prefix without ever supplying the literal, every prefix hit scans to the end and fails.
That makes the pass O(n²).

| Rule | 6 KB | 20 KB | 100 KB |
|------|------|-------|--------|
| JWT rule (pre-existing), `'eyJ'` repeated | 23 ms | 310 ms | (not run) |
| assertion rule (11.41.4), `'-abs_'` repeated | 13 ms | 140 ms | ~4 s |
| token rule `<p>_<24hex>_<64hex>` (bounded quantifiers) | <0.1 ms | <0.1 ms | 0.5 ms |

Input caps per caller:
- `HubLogBufferService.extract`: `maxMessageLength + 4096`, about 6 KB. That means about 13 to 23 ms
  per crafted line.
- `formatDiagnostic` (process diagnostics): 16 384 chars.
- `hub-query-profiler`: redacts first, then slices to 300. The error message is uncapped.
- `CoreHubMailboxService.store` in `copy` mode: `truncate(redact(html), cap)`. It redacts the FULL
  body BEFORE the cap. This is the only caller where the input is effectively unbounded.

**How to apply:** a new rule of this shape adds to a hazard that already exists. It does not create a new
class, because the JWT rule is worse. Treat it as a finding only if the diff also removes a cap or adds a
caller that feeds uncapped, attacker-shaped text. The real fix is shared across rules: cap before
redacting in the mailbox and query profiler, or bound the `{16,}` / `{6,}` runs.

Related: [[api-token-module-perf]]
