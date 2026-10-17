---
name: mongoose-cast-error-filter-costs
description: Measured costs of MongooseCastErrorFilter's request-walk classification (11.42.16) and of APP_FILTER registration; Mongoose 9 CastError value shapes.
metadata:
  type: project
---

Measured 2026-10-17 (Node 24, Mongoose 9.11.2, Nest core 11.2.7) against `src/core/common/filters/mongoose-cast-error.filter.ts`.

**Why:** the filter walks client data on the error path; these numbers settle whether a crafted request can make that expensive, so the next review does not have to re-measure from scratch.

**How to apply:** re-measure only if the bounds (MAX_WALK_DEPTH 32 / MAX_WALK_NODES 10,000), the candidate-Set construction, or the walk order change.

- **APP_FILTER costs nothing on a non-throwing request.** Default-scope provider → `scanner.applyApplicationProviders` → `addGlobalFilter(instance)` (static). REST `RouterProxy` and GraphQL `ExternalErrorProxy` only consult filters inside `catch`. Request-scoped GraphQL resolvers rebuild the filter context per call (+1 bind + 1 `Reflect.getMetadata`, sub-µs) — pre-existing mechanism.
- **Walk cost:** ~1 ms per 10k nodes (strings/floats), whether found last or missed; a skipped oversized dictionary object costs its full `for…in` key materialization (O(K log K)) but each object is visited once, so a body costs ≤ ~1× its JSON.parse time. Depth chain 100k → 0.004 ms; 5,000 self-refs → 0.1 ms; Buffers/typed arrays skipped in µs.
- **Large CastError value is the costlier shape:** Mongoose 9 puts the WHOLE client array in `CastError.value` for `{ f: { $eq: [...] } }`, `$gt`, a nested array, and `$set: { scalar: [...] }` (but only the single element for `$in`/`$nin`/`$all`/implicit arrays). The filter then builds `new Set(candidates)` once per helper call — 3× on REST (params, query, body), 2× on GraphQL. Measured: array(10k) → 1.3 ms REST / 0.9 ms GraphQL vs Mongoose's own cast 0.22 ms; array(1M, ~9.6 MB body) → 310 ms vs JSON.parse 169 ms. Linear, ~2× parse; transient heap only.
- **GraphQL aliases multiply it** (one CastError per aliased field, variable parsed once): ≤ ~1 ms/alias at a 100 kB variable; bounded by body limit × `graphQl.maxComplexity` (repo config 1000; the plugin skips the check when unset). Judged a constant factor over per-alias pipeline work, not reported.
- **Nothing retained:** two static `Logger`s; `seen`/`stack`/`wanted` are locals.

Related: [[body-parser-wrapper-costs]], [[auth-gate-per-request-cost]].
