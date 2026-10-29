---
name: bullmq-peer-range-api-drift
description: The optional peer bullmq is declared >=5.16.0 <7, but Queue APIs and their "missing" semantics drift inside that range — check every new bullmq call against the floor, not against the 6.x devDependency
metadata:
  type: reference
---

`package.json` declares `bullmq: '>=5.16.0 <7'` (set in 11.33.0, explained in
`migration-guides/11.32.x-to-11.33.x.md` as "the release that introduced the Job Scheduler API"). The repo's
own tests run against the devDependency (6.5.0 as of 2026-10-29), so a call that only works on newer
versions passes every suite.

Measured 2026-10-29 (12.1.1 review, DEV-3889 scheduler restore) with a probe against the test Redis on :6380:

| bullmq | `queue.getJobScheduler(id)` for a scheduler Redis lost |
|--------|--------------------------------------------------------|
| 5.16.0 – 5.22.x | method does not exist (TypeError) |
| 5.23.0 – 5.40.2 | a TRUTHY object (`{ key, pattern: null, ... }`): `hgetall` returns `{}`, later `keyToData()` |
| 5.40.3+ (incl. 6.x) | `undefined` (6.x throws for a legacy `a:b:c` key shape) |

`queue.getJobSchedulers()` (used by `removeStaleBullSchedulers()`) answers correctly on all of them.

Real consumer in the gap: a vendor-mode project pins `bullmq` 5.29.1 for its own queues
(as of 2026-10-29; it had no `redis` config then, so BullMQ cron mode was not active).

**How to apply:** when a diff adds a bullmq call or relies on its return shape, check it against 5.16.0.
Recipe: `npm install --ignore-scripts --prefix <scratch>/inst-<v> bullmq@<v>` per version, a `.cjs` probe in a
separate scratch dir that `require(<inst>/node_modules/bullmq)` + its ioredis, unique `prefix`, delete its keys
afterwards. See [[executable-doc-recipes]], [[optional-peer-vendor-delivery]].
