# NPM Package Maintainer Memory

## Project: nest-server

### Package Manager
- Uses **pnpm** (pnpm-lock.yaml)
- Use `pnpm add`, `pnpm remove`, `pnpm install`

### Blocked Updates (documented)
- `@getbrevo/brevo` 3.x → 5.x: Complete API redesign (TransactionalEmailsApi, SendSmtpEmail, TransactionalEmailsApiApiKeys removed). Would require rewriting `src/core/common/services/brevo.service.ts`. See `blocking-updates.md` for details.
- `graphql-upload` 15.x → 17.x: Extension changed from `.js` to `.mjs`. Import paths in `src/core.module.ts`, `src/core/modules/file/core-file.resolver.ts`, `src/server/modules/file/file.resolver.ts`, and `src/types/graphql-upload.d.ts` would all need updating.
- `vite` 7.x → 8.x + `vite-plugin-node` 7.x → 8.x: Both must update together. vite-plugin-node@8.0.0 peerDep requires `vite: '^8.0.0'`. Blocked together.
- `better-auth` + `@better-auth/passkey` 1.5.5 → 1.6.x: `@better-auth/core@1.6.x` adds `@opentelemetry/api` as a required (non-optional) peer dependency. Causes "Cannot find package '@opentelemetry/api'" errors. Verified on 2026-04-17 for 1.6.5. Do NOT update until better-auth makes @opentelemetry/api optional or we add @opentelemetry/api as a dev dep.
- `typescript` 5.x → 6.x: TypeScript 6.0.3 released. Ecosystem readiness still unknown — skip until NestJS/tools explicitly support it.
- `ts-morph` 27.x → 28.x: `@nestjs/graphql@13.2.5` only supports up to `^27.0.0` in peerDeps. Also `@compodoc/compodoc@1.2.1` requires `ts-morph@^27.0.2`. Cannot update ts-morph until both packages ship with ^28.0.0 support.
- `vite` 7.x → 8.x + `vite-plugin-node` 7.x → 8.x: Both must update together. vite-plugin-node@8.0.0 peerDep requires `vite: '^8.0.0'`. Blocked together.

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
- `mongoose@9.4.1` bundles `~mongodb@7.1.x` (same as 9.3.x), so current mongodb@7.1.1 is still compatible.
- mongodb@7.1.1 is still the latest in the 7.x line — no update needed there.

### Overrides Status (updated 2026-04-17)
- `axios@<1.15.0` → `1.15.0`: SSRF CVE (GHSA-3p68-rc4w-qgx5) + metadata exfiltration (GHSA-fvcv-3m26-pcqx). Both @getbrevo/brevo@3.0.1 (requires ^1.6.8) and node-mailjet@6.0.11 (requires ^1.12.0) naturally resolve to 1.15.0, but override kept as explicit security guarantee.
- minimatch overrides: at latest versions (3.1.5, 9.0.9, 10.2.5) — still needed
- `ajv` overrides (6.14.0, 8.18.0): still needed
- `undici@>=7.0.0 <7.25.0` → `7.25.0`: **UPDATED 2026-04-17** (was 7.24.7). @compodoc/compodoc@1.2.1>cheerio@1.1.2 requires `^7.12.0`, would install 7.25.0 without override.
- `srvx@<0.11.15` → `0.11.15` override: still needed. @tus/server 2.3.0 requires `~0.8.2` — still needed
- `handlebars@>=4.0.0 <4.7.9` → `4.7.9` override: still needed via @compodoc/compodoc
- `brace-expansion` overrides (1.1.13, 5.0.5): still needed
- `picomatch` overrides (2.3.2, 4.0.4): still needed
- `kysely@>=0.26.0 <0.28.16` → `0.28.16`: **UPDATED 2026-04-17** (was 0.28.15). better-auth@1.5.5 requires `^0.28.11`, selector widened to cover 0.28.15 now too.
- `path-to-regexp@>=8.0.0 <8.4.2` → `8.4.2` override: still needed (express@5.2.1>router)
- `lodash@>=4.0.0 <4.18.0` → `4.18.1` override: @nestjs/graphql pins lodash@4.17.23 which has CVE. 4.18.1 is the latest.
- `defu@<=6.1.6` → `6.1.7` override: still needed (better-auth uses 6.1.7 directly now)
- `follow-redirects@<=1.15.11` → `1.16.0` override: GHSA-r4q5-vmmm-2653 - transitive via axios
- **REMOVED 2026-04-03**: `file-type`, `yauzl`, `flatted`, `rollup` overrides

### json-to-graphql-query in dependencies (not devDependencies)
- Used in `src/test/test.helper.ts` which is EXPORTED via `src/index.ts`. Must remain in `dependencies`.

### oxfmt versioning note
- `oxfmt` is at 0.x (zero-version). Treated as MEDIUM risk updates.

### Key Files
- `/Users/kaihaase/code/lenneTech/nest-server/package.json` - main package config
- `/Users/kaihaase/code/lenneTech/nest-server/src/core/common/services/brevo.service.ts` - uses @getbrevo/brevo v3 API
- `/Users/kaihaase/code/lenneTech/nest-server/src/types/graphql-upload.d.ts` - custom type declarations for graphql-upload
