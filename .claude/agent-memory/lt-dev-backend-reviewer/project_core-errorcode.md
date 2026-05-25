---
name: core-errorcode
description: In the nest-server framework repo, src/core has its own ErrorCode registry at src/core/modules/error-code/ — used by modern core modules but not consistently across the whole core baseline
metadata:
  type: project
---

In THIS repo (`@lenne.tech/nest-server` framework, not a consumer project), the core ErrorCode registry lives at `src/core/modules/error-code/error-codes.ts` and is imported as `import { ErrorCode } from '../../error-code'`. It contains LTNS_* codes including `RATE_LIMIT_EXCEEDED`, `ACCESS_DENIED`, `RESOURCE_NOT_FOUND`, `SERVICE_UNAVAILABLE`.

**Why:** Relevant when reviewing exception handling in `src/core/**`. The skill's ErrorCode rule is written for consumer projects (`src/server/common/errors/project-errors.ts`), which does NOT apply to the framework repo — but core modules still have a registry to use.

**How to apply:** When reviewing new code in `src/core/`, modern modules (auth service, roles guard) use `ErrorCode.*`. However the baseline is MIXED — `core-user.service.ts` still uses raw-string exceptions. So raw-string exceptions in new core code are a real finding (modern pattern available + matching codes exist), but classify as Medium given the inconsistent existing baseline, not High. Verify current state with `grep -n "import.*ErrorCode" src/core/modules/<module>/...` before citing.
