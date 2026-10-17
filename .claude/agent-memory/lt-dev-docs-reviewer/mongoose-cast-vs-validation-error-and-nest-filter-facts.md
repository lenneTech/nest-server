---
name: mongoose-cast-vs-validation-error-and-nest-filter-facts
description: Mongoose reports a malformed id as CastError only on QUERY casting; save/create/insertMany yield ValidationError. Plus Nest 11.2.7 filter facts to check exception-filter doc claims against
metadata:
  type: reference
---

Verified 2026-10-17 while reviewing `MongooseCastErrorFilter` (11.42.16, uncommitted). Re-verify after a
Mongoose or Nest major.

**Mongoose 9 — which error a malformed ObjectId produces**
- Query casting (`find`, `findById`, `findByIdAndUpdate`, `updateOne` incl. `$set`): `mongoose.Error.CastError`.
- Document casting (`new Model(x).save()`, `Model.create()`, `insertMany()`): `ValidationError`
  whose `errors.<path>` is a CastError — NOT `instanceof CastError`, so `@Catch(MongooseError.CastError)`
  never sees it. `CrudService.create()` writes via `.save()`, `CrudService.update()` via `findByIdAndUpdate`.
- Any doc claiming "a malformed id in the body → 400" for a CastError-only filter is false for creates.
- Reproduce without a DB: `mongoose.set('bufferCommands', false)` then `Model.create({ ref: 'bad' })`.

**Nest 11.2.7 exception-filter internals** (node_modules/@nestjs/core/exceptions/)
- Global filter order: APP_FILTER is pushed at create/compile time, `useGlobalFilters()` concats later,
  `RouterExceptionFilters` reverses → a `main.ts` catch-all is consulted FIRST.
- REST: a matched filter must reply itself (`ExceptionsHandler.next` returns once a filter matched).
- GraphQL (`ExternalExceptionsHandler`): a falsy filter result falls back to `ExternalExceptionFilter`
  (log + rethrow); a returned Error becomes the field error.
- `BaseExceptionFilter.handleUnknownError` logs `logger.error(exception)` (whole Error, inspected) under
  `ExceptionsHandler` — not `(message, stack)` as Nest 10 did. A filter "mimicking Nest's log line" with
  `(message, stack)` matches level/context but not the text/JSON shape.
- `@nestjs/websockets` 11.2.7 `ExceptionFiltersContext.getGlobalMetadata()` returns `[]`: APP_FILTER /
  global filters never reach WebSocket gateways (no swallowing risk there).
- No GraphQL `formatError` masking in nest-server: an unhandled error's message reaches GraphQL clients.
