---
name: tus-protocol-config-facts
description: How @tus/server 2.4.5 treats extension flags, ids and upload URLs, and how TusModule.forRoot() mutates class-level route metadata — facts that decide whether a TUS config test is real
metadata:
  type: project
---

Verified 2026-10-07 while reviewing the 11.42.9 TUS config fixes (`tests/unit/tus-module-config.spec.ts`,
`tests/tus-protocol-config.e2e-spec.ts`).

- **@tus/server consults no creation/termination flag.** PostHandler checks `hasExtension()` only for
  concatenation and `creation-defer-length`; DeleteHandler checks nothing. So a 501 on POST/DELETE under
  `creation: false` / `termination: false` comes from nest-server's own `assertExtensionEnabled()` in
  `onIncomingRequest` (which tus calls for POST too, before `onUploadCreate` and before any byte is
  written). Filtering `datastore.extensions` only changes the OPTIONS advertisement.
- **Resume does not depend on `path`.** `getFileIdFromRequest()` takes the LAST path segment
  (`/([^/]+)\/?$/`) and only rejects an id that is a substring of `options.path`. A HEAD on a wrong-prefix
  URL still answers 200 against a raw `server.handle()` — so a Location test must assert the pathname,
  not just that HEAD works. The spec does.
- `generateUrl(req, …)` receives the WHATWG request; `req.url` is absolute there.
- **`TusModule.forRoot()` writes `PATH_METADATA` onto the controller CLASS** (`applyPath`, 11.42.9) and
  remembers the declared route in a static WeakMap. Nest reads that metadata at app init, so a unit test
  on the metadata is a valid proxy for routing. Its afterEach restore (`forRoot()` before the
  ConfigService restore) only works when the server config the case left behind is ENABLED — fine
  today, order-independent under `--sequence.shuffle` (6 seeds), fragile if a case moves the path AND
  leaves `tus: false`.
- **Unit runner isolation is a DEFAULT, not configured**: `vitest.config.ts` sets no `pool`/`isolate`;
  vitest 4.1 defaults are `isolate: true` + forks, so class metadata / static state cannot leak across
  unit files. Check that the default still holds if the config ever sets `isolate: false`.
- `creationWithUpload: false` has no test; judged Low (protocol capability, same gates as a PATCH).

**How to apply:** for any TUS extension test, assert the status AND that the store is unchanged (the
spec's HEAD-after-DELETE); run the raw-service e2e alone in ~5s with
`NODE_ENV=e2e npx vitest run --config vitest-e2e.config.ts <file>`. Related:
[[tus-compression-end-callback-facts]], [[configservice-singleton-in-tests]].
