# NPM Package Maintainer Memory

## Project: nest-server

### Package Manager
- Uses **pnpm** (pnpm-lock.yaml)
- Use `pnpm add`, `pnpm remove`, `pnpm install`

### Blocked Updates (documented)
- `@getbrevo/brevo` 3.x → 5.x: Complete API redesign (TransactionalEmailsApi, SendSmtpEmail, TransactionalEmailsApiApiKeys removed). Would require rewriting `src/core/common/services/brevo.service.ts`. See `blocking-updates.md` for details.
- `graphql-upload` 15.x → 17.x: Extension changed from `.js` to `.mjs`. Import paths in `src/core.module.ts`, `src/core/modules/file/core-file.resolver.ts`, `src/server/modules/file/file.resolver.ts`, and `src/types/graphql-upload.d.ts` would all need updating.
- `vite` 7.x → 8.x: `vite-plugin-node` peer dependency requires `vite: '^7.0.0'` — blocked until vite-plugin-node releases vite 8 support.

### Critical Categorization Issue (Fixed in 2026-03-11)
- `ts-morph` was incorrectly in `devDependencies` but is IMPORTED in `src/core/modules/permissions/permissions-scanner.ts`. Moved to `dependencies`.

### Version Coupling: mongodb + mongoose
- `mongodb` and `mongoose` must be updated TOGETHER. Mongoose bundles its own mongodb version internally, so they must match.
- `mongoose@9.3.0` bundles `~mongodb@7.1.x`, so `mongodb@7.1.0` must be updated simultaneously.

### Overrides Status (updated 2026-03-15)
- All overrides still needed: minimatch (3.x, 9.x, 10.x), rollup, ajv
- `file-type@>=13.0.0 <21.3.2` override (was `<21.3.1`, updated to fix GHSA-5v7r-6r5c-r473)
- `undici@>=7.0.0 <7.24.0` → `7.24.3` override ADDED (fixes GHSA-f269-vfmq-vjvj, GHSA-vrm6-8vpv-qv8q, GHSA-v9p9-hfj2-hcw8, GHSA-2mjp-6q6p-2qxm, GHSA-phc3-fgpg-7m6h via @compodoc/compodoc>cheerio)
- `yauzl@<3.2.1` → `3.2.1` override ADDED (fixes GHSA-gmq8-994r-jv83 via @swc/cli)

### json-to-graphql-query in dependencies (not devDependencies)
- Used in `src/test/test.helper.ts` which is EXPORTED via `src/index.ts`. Must remain in `dependencies`.

### oxfmt versioning note
- `oxfmt` is at 0.x (zero-version). Treated as MEDIUM risk updates.

### Key Files
- `/Users/kaihaase/code/lenneTech/nest-server/package.json` - main package config
- `/Users/kaihaase/code/lenneTech/nest-server/src/core/common/services/brevo.service.ts` - uses @getbrevo/brevo v3 API
- `/Users/kaihaase/code/lenneTech/nest-server/src/types/graphql-upload.d.ts` - custom type declarations for graphql-upload
