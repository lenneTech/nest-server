---
name: cron-doc-surfaces
description: Where CoreCronJobs behaviour is documented and which JSDoc is the live one (verified 2026-10-29, DEV-3896)
metadata:
  type: project
---

Cron dedup/runParallel behaviour has exactly these doc surfaces: the "Cron Job Deduplication" row in
`.claude/rules/configurable-features.md` (the full spec), the JSDoc of `distributed` / `runParallel` in
`cron-job-config.interface.ts`, README.md feature bullets (~l.387-390), the historical
`migration-guides/11.32.x-to-11.33.x.md` §9. Hub README, REQUEST-LIFECYCLE and FRAMEWORK-API describe none
of the mechanics (FRAMEWORK-API only lists `cronJobs?`; CronJobConfig is not on the generator allowlist).

**Why:** `CronJobConfig` is `@deprecated`, but `CronJobConfigWithTimeZone` and `...WithUtcOffset` both
`extends CronJobConfig` without redeclaring `distributed` / `runParallel` — so the JSDoc on the deprecated
base IS what consumers see. Don't flag an edit there as "documented on the wrong interface".

**How to apply:** the class JSDoc's "unless `distributed: false`" claim and the row's "(MongoDB lease)" wording were
corrected in DEV-3896 (default is OFF without redis; Redis → SQL lease table → MongoDB). Lease key format is
`<job>:<second-floored ISO>`, so old and new replicas agree in a rolling deploy. Related: [[bullmq-peer-range-api-drift]],
[[patch-release-migration-guide-convention]].
