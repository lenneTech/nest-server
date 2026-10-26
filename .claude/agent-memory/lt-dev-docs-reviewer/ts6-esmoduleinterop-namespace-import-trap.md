---
name: ts6-esmoduleinterop-namespace-import-trap
description: TypeScript 6 forces esModuleInterop, so `import * as GraphQLUpload from 'graphql-upload/GraphQLUpload.js'` compiles green and the app fails at boot; nest-server's own CoreFileResolver (and vendored cores) carried it up to 11.43.3
metadata:
  type: project
---

TypeScript 6 refuses `esModuleInterop: false` (TS5107 unless `ignoreDeprecations`), so every
`import * as X from '<cjs export= module>'` compiles to `__importStar(require(...))` — a plain wrapper
object, under `module: commonjs` AND `nodenext`. For a CALLED namespace TS reports an error; for one used
as a VALUE it says nothing. Measured 2026-10-24 with TS 6.0.3 + @nestjs/graphql 14.0.3:
`import * as GraphQLUpload from 'graphql-upload/GraphQLUpload.js'` + `@Args({ type: () => GraphQLUpload })`
→ tsc exit 0, boot fails with `Cannot determine a GraphQL input type for the "file"`. TS 5.9 (starter
default, no esModuleInterop) → `require()` → the real scalar, works.

Who carries that form: NOT the lt CLI generator — its `imports.GraphQLUpload` entry existed but was never emitted
(per cli-f0, 2026-10-25: file inputs were forced to `CoreFileInfo`, a different boot error; since then the generator
picks the root export when `common/scalars/upload.scalar` exists, else `import = require`). It is nest-server's own `CoreFileResolver` until 11.43.3 (so every vendored core up to
then), and older jest-based projects (deploy.party, nest-server 10.8.2). Under vitest + unplugin-swc the
namespace import was NEVER the scalar (proven), so a vitest-tested starter project cannot have it on a live
resolver — the exposed population is tsc / ts-jest / ts-node-run projects.

**Why:** the 12.0.0 guide's §2 said only *called* namespace imports break, and §13 framed the switch to
nest-server's `GraphQLUpload` export as optional — reported High on 2026-10-24, fixed in the guide the same day (§2 value-import case, §13 "Before — BROKEN" form, troubleshooting row). The cli side was fixed separately (generator now detects the framework export by the `upload.scalar` path — a contract pinned in `tests/unit/upload-scalar-contract.spec.ts`).
**How to apply:** on any guide that raises TypeScript to 6+, grep consumers for `import \* as` of CJS
`export =` VALUES (scalars, singletons) and check the guide names the boot symptom. Recipe in
[[executable-doc-recipes]]. Related: [[migration-guide-behavior-change-count-trap]].
