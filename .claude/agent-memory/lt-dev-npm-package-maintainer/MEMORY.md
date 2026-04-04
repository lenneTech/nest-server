# NPM Package Maintainer Memory

## Project: nest-server

### Package Manager
- Uses **pnpm** (pnpm-lock.yaml)
- Use `pnpm add`, `pnpm remove`, `pnpm install`

### Blocked Updates (documented)
- `@getbrevo/brevo` 3.x → 5.x: Complete API redesign (TransactionalEmailsApi, SendSmtpEmail, TransactionalEmailsApiApiKeys removed). Would require rewriting `src/core/common/services/brevo.service.ts`. See `blocking-updates.md` for details.
- `graphql-upload` 15.x → 17.x: Extension changed from `.js` to `.mjs`. Import paths in `src/core.module.ts`, `src/core/modules/file/core-file.resolver.ts`, `src/server/modules/file/file.resolver.ts`, and `src/types/graphql-upload.d.ts` would all need updating.
- `vite` 7.x → 8.x + `vite-plugin-node` 7.x → 8.x: Both must update together. vite-plugin-node@8.0.0 peerDep requires `vite: '^8.0.0'`. Blocked together.
- `better-auth` + `@better-auth/passkey` 1.5.5 → 1.5.6: `@better-auth/core@1.5.6/dist/instrumentation/tracer.mjs` directly imports `@opentelemetry/api` (SpanStatusCode, trace) — causes "Cannot find package '@opentelemetry/api'" errors across 38+ test files. Verified on 2026-04-04. Do NOT update until better-auth resolves this dep or we add @opentelemetry/api as a dev dep.
- `typescript` 5.x → 6.x: TypeScript 6.0.2 released 2026-03-23 (very new). Ecosystem readiness unknown — skip until NestJS/tools explicitly support it.

### Critical Categorization Issue (Fixed in 2026-03-11)
- `ts-morph` was incorrectly in `devDependencies` but is IMPORTED in `src/core/modules/permissions/permissions-scanner.ts`. Moved to `dependencies`.

### Version Coupling: mongodb + mongoose
- `mongodb` and `mongoose` must be updated TOGETHER. Mongoose bundles its own mongodb version internally, so they must match.
- `mongoose@9.4.1` bundles `~mongodb@7.1.x` (same as 9.3.x), so current mongodb@7.1.1 is still compatible.
- mongodb@7.1.1 is still the latest in the 7.x line — no update needed there.

### Overrides Status (updated 2026-04-04)
- minimatch overrides: updated to latest versions (3.1.5, 9.0.9, 10.2.5)
- `rollup@>=4.0.0 <4.60.1` → `4.60.1` override: still needed (4.60.1 is current latest)
- `ajv` overrides still needed
- `undici@>=7.0.0 <7.24.7` → `7.24.7` override: updated from 7.24.3. @compodoc/compodoc>cheerio requires `^7.12.0` — still needed in 7.x range
- `srvx@<0.11.15` → `0.11.15` override: updated from 0.11.13. @tus/server 2.3.0 requires `~0.8.2` — still needed
- `handlebars@>=4.0.0 <4.7.9` → `4.7.9` override: @compodoc/compodoc requires `^4.7.8` — still needed for safety
- `brace-expansion`, `picomatch`, `kysely` overrides: still needed (at latest)
- `path-to-regexp@>=8.0.0 <8.4.2` → `8.4.2` override: updated from 8.4.1 (new patch)
- `lodash@>=4.0.0 <4.18.0` → `4.18.1` override: @nestjs/graphql pins lodash@4.17.23 which has CVE. 4.18.1 is now the latest lodash.
- `defu@<=6.1.4` → `6.1.6` override: still needed (6.1.6 is current latest)
- **REMOVED 2026-04-03**: `file-type@>=13.0.0 <21.3.2` → all nestjs packages now at 11.1.17 with file-type 21.3.2 natively
- **REMOVED 2026-04-03**: `yauzl@<3.2.1` → @swc/cli 0.8.1 bundles yauzl 3.2.1 directly
- **REMOVED 2026-04-03**: `flatted@<=3.4.1` → @vitest/ui 4.1.2 requires `^3.4.2` already

### json-to-graphql-query in dependencies (not devDependencies)
- Used in `src/test/test.helper.ts` which is EXPORTED via `src/index.ts`. Must remain in `dependencies`.

### oxfmt versioning note
- `oxfmt` is at 0.x (zero-version). Treated as MEDIUM risk updates.

### Key Files
- `/Users/kaihaase/code/lenneTech/nest-server/package.json` - main package config
- `/Users/kaihaase/code/lenneTech/nest-server/src/core/common/services/brevo.service.ts` - uses @getbrevo/brevo v3 API
- `/Users/kaihaase/code/lenneTech/nest-server/src/types/graphql-upload.d.ts` - custom type declarations for graphql-upload
