# NPM Package Maintainer Memory

## Project: nest-server

### Package Manager
- Uses **pnpm** (pnpm-lock.yaml)
- Use `pnpm add`, `pnpm remove`, `pnpm install`

### Blocked Updates (documented)
- `@getbrevo/brevo` 3.x → 5.x: Complete API redesign (TransactionalEmailsApi, SendSmtpEmail, TransactionalEmailsApiApiKeys removed). Would require rewriting `src/core/common/services/brevo.service.ts`. See `blocking-updates.md` for details.
- `graphql-upload` 15.x → 17.x: Extension changed from `.js` to `.mjs`. Import paths in `src/core.module.ts`, `src/core/modules/file/core-file.resolver.ts`, `src/server/modules/file/file.resolver.ts`, and `src/types/graphql-upload.d.ts` would all need updating.
- `vite` 7.x → 8.x: `vite-plugin-node` peer dependency requires `vite: '^7.0.0'` — blocked until vite-plugin-node releases vite 8 support.
- `better-auth` + `@better-auth/passkey` 1.5.5 → 1.5.6: Introduces `@opentelemetry/api` as new mandatory dependency in `@better-auth/core/dist/instrumentation/tracer.mjs` — causes "Cannot find package '@opentelemetry/api'" errors across 38 test files. Do NOT update until better-auth resolves this dep or we add @opentelemetry/api.
- `typescript` 5.x → 6.x: TypeScript 6.0.2 released 2026-03-23 (very new). Ecosystem readiness unknown — skip until NestJS/tools explicitly support it.

### Critical Categorization Issue (Fixed in 2026-03-11)
- `ts-morph` was incorrectly in `devDependencies` but is IMPORTED in `src/core/modules/permissions/permissions-scanner.ts`. Moved to `dependencies`.

### Version Coupling: mongodb + mongoose
- `mongodb` and `mongoose` must be updated TOGETHER. Mongoose bundles its own mongodb version internally, so they must match.
- `mongoose@9.3.0` bundles `~mongodb@7.1.x`, so `mongodb@7.1.0` must be updated simultaneously.

### Overrides Status (updated 2026-03-31)
- All overrides still needed: minimatch (3.x, 9.x, 10.x), rollup, ajv
- `file-type@>=13.0.0 <21.3.2` → `21.3.2` override: @nestjs/common 11.1.17 now bundles `file-type: 21.3.2` — this override can be removed when ALL nestjs packages are at >=11.1.17
- `undici@>=7.0.0 <7.24.0` → `7.24.3` override (via @compodoc/compodoc>cheerio)
- `yauzl@<3.2.1` → `3.2.1` override: @swc/cli 0.8.0 now bundles yauzl 3.2.1 directly — override still safe to keep
- NEW overrides added 2026-03-31 (security):
  - `flatted@<=3.4.1` → `3.4.2` (GHSA-rf6f-7fwh-wjgh via @vitest/ui)
  - `srvx@<0.11.13` → `0.11.13` (middleware bypass via @tus/server)
  - `handlebars@>=4.0.0 <4.7.9` → `4.7.9` (JS injection via @compodoc/compodoc)
  - `brace-expansion@<1.1.13` → `1.1.13` and `brace-expansion@>=4.0.0 <5.0.5` → `5.0.5`
  - `picomatch@<2.3.2` → `2.3.2` and `picomatch@>=4.0.0 <4.0.4` → `4.0.4`
  - `path-to-regexp@>=8.0.0 <8.4.0` → `8.4.1` (DoS via @nestjs/core)
  - `kysely@>=0.26.0 <0.28.15` → `0.28.15` (SQL injection via better-auth)
- `rollup` override updated to `4.60.1` (latest)

### json-to-graphql-query in dependencies (not devDependencies)
- Used in `src/test/test.helper.ts` which is EXPORTED via `src/index.ts`. Must remain in `dependencies`.

### oxfmt versioning note
- `oxfmt` is at 0.x (zero-version). Treated as MEDIUM risk updates.

### Key Files
- `/Users/kaihaase/code/lenneTech/nest-server/package.json` - main package config
- `/Users/kaihaase/code/lenneTech/nest-server/src/core/common/services/brevo.service.ts` - uses @getbrevo/brevo v3 API
- `/Users/kaihaase/code/lenneTech/nest-server/src/types/graphql-upload.d.ts` - custom type declarations for graphql-upload
