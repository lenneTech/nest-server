---
name: project-cast-error-filter-security-model
description: MongooseCastErrorFilter (11.42.16) reviewed clean; CastError value/path shapes, Nest falsy-filter fallback, walk cost at 100 kB, why the classification oracle is not a finding
metadata:
  type: project
---

MongooseCastErrorFilter (`src/core/common/filters/mongoose-cast-error.filter.ts`, APP_FILTER, 11.42.16) was security-reviewed on 2026-10-17 with zero findings.

Facts verified by probe (re-check with a `q.cast(M)` script against `node_modules/mongoose`, no DB needed):
- `CastError.value` for `$in` is the SINGLE failing element, not the array. The candidate set is therefore always tiny.
- A Map path is reported as `m.$*`, never with the stored key. The schema path is the only thing the 400 `[path]` echoes. The model name appears only in `.message`, and the filter never sends that.
- An object cast as a whole has an object `value`, so it yields no candidates, which classifies it as `server` (500).
- Nest `ExternalExceptionsHandler.next()` treats a falsy filter result as "not handled" and falls back to log + rethrow. This makes the GraphQL `server` branch byte-identical to the pre-filter behaviour. There is no `formatError` in core, so a server-origin GraphQL CastError still carries the Mongoose message. That predates the filter.
- nest-server has no `@nestjs/websockets`, so the WS handler's "a filter matched means swallowed" semantics do not apply.

Walk cost: about 1.3 ms for the widest object a 100 kB body allows (14k keys, V8 for-in materializes every key). Cycles, `__proto__` own keys and depth over 32 all degrade safely. A GraphQL alias multiplies it per field through a shared variable. Every arg path that holds such an object already pays an O(keys) class-transformer copy per field in MapAndValidatePipe, so this is not a new amplification.

**Why:** the 400-vs-500 difference is an equality oracle on a stored malformed value. It needs a full-value guess and gives no partial information, so it is theoretical and not reported. The "an attacker relabels a server defect" concern only affects the attacker's own requests.

**How to apply:** when this filter is touched again, re-run the probe on any Mongoose upgrade (a change of `$in` to whole-array values would grow the candidate set). Re-check the fallback if Nest changes `if (result)` in ExternalExceptionsHandler. See [[project-exception-wire-format]] for the `{ ...exception }` body shape it mirrors.
