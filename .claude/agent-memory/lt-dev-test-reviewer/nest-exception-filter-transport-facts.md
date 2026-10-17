---
name: nest-exception-filter-transport-facts
description: How an APP_FILTER that returns undefined behaves per transport (http/graphql/ws/rpc), and how global filter order is resolved; needed to judge "stays a 500" refusal tests for any core exception filter
metadata:
  type: reference
---

Facts verified 2026-10-17 while reviewing `MongooseCastErrorFilter` (11.42.16), against
`node_modules/@nestjs/core` and `@nestjs/websockets` 11.2.x. Re-check if Nest majors move.

- **Order:** `ExceptionsHandler` picks the FIRST matching filter of `globalFilters.reverse()`. APP_FILTER
  instances are added at compile time, `app.useGlobalFilters()` later, so a project's `useGlobalFilters`
  catch-all is consulted before a core APP_FILTER. A `@Catch(HttpException)` filter never matches a
  Mongoose error, so the core filter is reached.
- **REST:** a filter that matched MUST write the response itself; Nest does not fall back afterwards.
  So a "stays 500" path inside such a filter has to reproduce the generic body + `ExceptionsHandler`
  log on its own, and a refusal test that passes with the filter removed is EXPECTED (status quo).
- **GraphQL:** `ExternalExceptionsHandler.next()` returns the filter result if truthy, else
  `ExternalExceptionFilter` logs (context `ExceptionsHandler`) and rethrows. Returning `undefined` is a
  clean hand-back. A returned HttpException becomes the field error (graphql-js throws returned Errors).
- **WebSocket:** `@nestjs/websockets` `ExceptionFiltersContext.getGlobalMetadata()` returns `[]`, so
  APP_FILTER never reaches gateways. (Had it, `WsExceptionsHandler` treats any MATCHED filter as handled
  and would swallow the error when it returns undefined.) Not a risk for global filters.
- **RPC:** `RpcExceptionsHandler` falls back to its base filter when the custom filter returns falsy.
- nest-server itself installs neither `@nestjs/websockets` nor `@nestjs/microservices`; the `rpc` case
  in unit specs is a hand-built host only.

Log-ordering: a filter that calls `res.json()` and THEN `logger.error()` in the same tick is still
observed by a supertest assertion deterministically (client receipt needs later event-loop turns),
also with `compression: true`.

Related: [[e2e-isolation-model]]
