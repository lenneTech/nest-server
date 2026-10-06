---
name: project-body-parser-initializer
description: 11.42.4 CoreBodyParserInitializer swaps NestJS's global Express parser layers in onModuleInit; verified option parity, layer detection and known non-defects so they are not re-flagged.
metadata:
  type: project
---

`src/core/common/services/core-body-parser.initializer.ts` (11.42.4) applies `bodyParser.{json,urlencoded}.limit`
by replacing `layer.handle` of the global parser layers NestJS registered in `app.init()` (before
`callInitHook`), and wraps them unconfigured to turn body-parser's 413 into `#LTNS_0304`.

Verified 2026-10-06 against @nestjs/platform-express 11.2.7 / express 5.2.1 / router 2.2.0 / body-parser 2.3.0:
- Option parity with `ExpressAdapter.registerParserMiddleware`: json `{}` / urlencoded `{ extended: true }`,
  `verify` only with rawBody. `verify: undefined` is accepted by body-parser 2.x.
- Detection `layer.slash === true` is router 2.x (`path === '/' && end === false`, i.e. `app.use(fn)`);
  wrapper keeps `name` (NestJS `isMiddlewareApplied`) and arity 3 (router skips `length > 3`).
- rawBody read from `moduleRef.container.contextOptions` = the `NestFactory.create` options. Under
  `Test.createTestingModule()` it is not visible: documented caveat, not a defect.
- Fastify / application context: `getRouterStack()` returns undefined, no-op.
- Known Low, not reportable: a >309-digit limit string parses to `Infinity` (number branch rejects it,
  string branch does not) — operator config only.

**Why:** the layer swap looks fragile on first read; these were all checked and hold.
**How to apply:** on a later diff to this file, re-verify only what changed (e.g. a NestJS major that
alters `registerParserMiddleware` options or the router's `slash` flag).

Related: Better-Auth NestJS cookie signing reads `currentConfig.secret`, which since 11.42.4 comes from
`authInstance.options.secret` first (`resolveSigningSecret`). A `BETTER_AUTH_SECRETS` env (rotation
array) still makes Better-Auth sign with `secrets[0]` while the NestJS layer uses `options.secret` —
pre-existing divergence, not introduced there.
