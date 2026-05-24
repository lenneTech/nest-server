# NPM Package Maintainer Memory

## Project: nest-server

### Package Manager
- Uses **pnpm** (pnpm-lock.yaml)
- Use `pnpm add`, `pnpm remove`, `pnpm install`

### Blocked Updates (documented)
- `@getbrevo/brevo` 3.x → 5.x: Complete API redesign (TransactionalEmailsApi, SendSmtpEmail, TransactionalEmailsApiApiKeys removed). Would require rewriting `src/core/common/services/brevo.service.ts`. See `blocking-updates.md` for details.
- `graphql-upload` 15.x → 17.x: Extension changed from `.js` to `.mjs`. Import paths in `src/core.module.ts`, `src/core/modules/file/core-file.resolver.ts`, `src/server/modules/file/file.resolver.ts`, and `src/types/graphql-upload.d.ts` would all need updating.
- `@nestjs/swagger` 11.4.2 → 11.4.3+ (incl. 11.4.4): **BLOCKED (discovered 2026-05-24)**. 11.4.3 introduced a restrictive `exports` field exposing ONLY `.`, `./plugin`, `./package.json`. This breaks deep subpath imports that the framework relies on: `src/core/common/decorators/unified-field.decorator.ts` imports `@nestjs/swagger/dist/interfaces/schema-object-metadata.interface.js`, and the test `tests/project.e2e-spec.ts` imports `DECORATORS` from `@nestjs/swagger/dist/constants`. With 11.4.4, test fails: `"./dist/constants" is not exported under the conditions ["node","development","import"]`. 11.4.2 has NO exports field so deep subpaths work. KEEP at 11.4.2 until the src/ deep import is replaced with a public re-export (or upstream re-exposes the subpaths).
- `typescript` 5.x → 6.x: TypeScript 6.0.3 released. Ecosystem readiness still unknown — skip until NestJS/tools explicitly support it.
- `ts-morph` 27.x → 28.x: blocked ONLY by `@compodoc/compodoc@1.2.1` (deps `ts-morph@^27.0.2`). `@nestjs/graphql@13.4.2` peerDep already allows `^28.0.0` (verified 2026-05-24: `^20 || ^21 || ^24 || ^25 || ^26 || ^27 || ^28`). Cannot update until compodoc ships ^28.0.0 support.

### Resolved Blockers (no longer blocked, verified 2026-05-24)
- `vite` 8.x + `vite-plugin-node` 8.x: NO LONGER BLOCKED. Already on vite@8.0.14 + vite-plugin-node@8.0.0 in working tree, tests green. (Prior memory said blocked together — that was for the 7→8 jump; it's been done.)
- `better-auth` + `@better-auth/passkey` 1.6.x: NO LONGER BLOCKED. `@better-auth/core@1.6.10/1.6.11` marks `@opentelemetry/api` as `peerDependenciesMeta optional: true`. Project runs 1.6.11 green without @opentelemetry/api installed. The 1.6.5 required-peer issue is fixed upstream.

### Categorization Fix (Fixed 2026-04-07)
- `supertest` and `@types/supertest` moved from `devDependencies` to `dependencies`.
  Reason: `src/test/test.helper.ts` (exported via `src/index.ts`) imports `supertest` at runtime.
  Consuming projects would get runtime errors without it in `dependencies`.

### Categorization Fix (Fixed 2026-04-11)
- `find-file-up` moved from `dependencies` to `devDependencies`.
  Reason: Only used in `extras/sync-version.ts` (husky hook helper), not in `src/`. Not needed by consuming projects at runtime.
- `vite-tsconfig-paths` REMOVED entirely.
  Reason: Not imported anywhere in the codebase (no usage in any .ts, .js, or .mjs files).

### Critical Categorization Issue (Fixed in 2026-03-11)
- `ts-morph` was incorrectly in `devDependencies` but is IMPORTED in `src/core/modules/permissions/permissions-scanner.ts`. Moved to `dependencies`.

### Version Coupling: mongodb + mongoose
- `mongodb` and `mongoose` must be updated TOGETHER. Mongoose bundles its own mongodb version internally, so they must match.
- Current (2026-05-24): mongodb@7.2.0 + mongoose@9.6.2 (both updated in earlier sessions). Keep matched.

### Overrides Status (updated 2026-05-24)
- Empirical obsolescence test: removing ALL overrides + `pnpm install --lockfile-only` then `pnpm audit` reveals ONLY 3 packages still flagged → `ajv` (ReDoS via $data, <8.18.0), `picomatch` (ReDoS/method-injection, <4.0.4), `uuid` (<11.1.1). All other security overrides are currently no-op floors (parents caught up naturally) but KEPT as defense-in-depth against future transitive downgrades. This empirical method (strip overrides → lockfile-only → audit) is the reliable way to find genuinely-needed vs no-op security overrides.
- `axios@<1.16.0` → `1.16.0`: SSRF + multiple CVEs. transitive via @getbrevo/brevo + node-mailjet. Kept.
- minimatch overrides (3.1.5, 9.0.9, 10.2.5): kept
- `ajv` overrides (6.14.0, 8.18.0): STILL STRICTLY NEEDED (8.18.0 floor blocks ReDoS in 8.17.1 via @angular-devkit)
- `undici@>=7.0.0 <7.25.0` → `7.25.0`: kept
- `handlebars@>=4.0.0 <4.7.9` → `4.7.9`: kept (via @compodoc/compodoc)
- `brace-expansion` overrides (1.1.13, 5.0.6): kept
- `picomatch` overrides (2.3.2, 4.0.4): STILL STRICTLY NEEDED (4.0.4 floor blocks ReDoS in 4.0.3 via @angular-devkit)
- `kysely@>=0.26.0 <0.28.17` → `0.28.17`: kept. @better-auth/core@1.6.11 requires kysely `^0.28.17`.
- `path-to-regexp@>=8.0.0 <8.4.2` → `8.4.2`: kept (express@5.2.1>router)
- `lodash@>=4.0.0 <4.18.0` → `4.18.1`: kept
- `defu@<=6.1.6` → `6.1.7`: kept
- `follow-redirects@<=1.15.11` → `1.16.0`: kept
- `@protobufjs/utf8@<=1.1.0` → `1.1.1`, `ws@>=8.0.0 <8.20.1` → `8.20.1`, `qs@>=6.11.1 <=6.15.1` → `6.15.2`: kept (the 5 explicitly-protected security overrides)
- `uuid@<14.0.0` → `14.0.0`: STILL STRICTLY NEEDED (uuid <11.1.1 via @compodoc/compodoc)
- `postcss@<8.5.10` → `8.5.12`: kept (via vite)
- **REMOVED 2026-05-24**: `srvx@<0.11.15` → `0.11.15`. Obsolete COMPATIBILITY override: @tus/server upgraded 2.3.0→2.4.1, which now natively pins `srvx@~0.11.15`. The `~` constraint guarantees the floor; override removed, srvx still resolves to 0.11.15, audit clean.
- **REMOVED 2026-04-03**: `file-type`, `yauzl`, `flatted`, `rollup` overrides

### json-to-graphql-query in dependencies (not devDependencies)
- Used in `src/test/test.helper.ts` which is EXPORTED via `src/index.ts`. Must remain in `dependencies`.

### oxfmt versioning note
- `oxfmt` is at 0.x (zero-version). Treated as MEDIUM risk updates.

### Key Files
- `/Users/kaihaase/code/lenneTech/nest-server/package.json` - main package config
- `/Users/kaihaase/code/lenneTech/nest-server/src/core/common/services/brevo.service.ts` - uses @getbrevo/brevo v3 API
- `/Users/kaihaase/code/lenneTech/nest-server/src/types/graphql-upload.d.ts` - custom type declarations for graphql-upload
