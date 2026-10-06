---
name: multitenancy-off-is-the-default-path
description: nest-server and nest-server-starter configure NO multiTenancy, so for any feature that branches on it the OFF side is the path most consumers run — check that a spec asserts that side, not only the richer ON fixture
metadata:
  type: project
---

Neither `src/config.env.ts` here nor the starter's sets `multiTenancy` (verified 2026-10-06). A spec
that builds one "full" fixture with `multiTenancy: {}` and asserts every behaviour there leaves the
consumer-default branch unasserted.

Seen in the 11.42.7 swagger-helper review (`tests/unit/swagger-helper.spec.ts`): all per-operation
`security` assertions ran with multi-tenancy on; the "features off" case asserted only the global
requirement. Mutation `isPublic = !roles.some(Boolean) || (!multiTenancy || …)` (drop the
`roles.includes(S_EVERYONE) &&` guard) marks EVERY route `security: []` without multi-tenancy and kept
all 13 tests green; a 3-line assertion on `/items` + `/mixed/open` in the plain document turned it red
(shipped with 11.42.7 in the "features off" case).

**How to apply:** for a helper/guard with a `multiTenancy` branch, find which assertions run with it
OFF. If none touch the security-relevant output, run the drop-the-guard mutation in a scratch copy
([[scratch-copy-mutation-check]]) before calling the coverage adequate.
