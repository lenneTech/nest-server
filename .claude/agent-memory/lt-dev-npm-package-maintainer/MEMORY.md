# NPM Package Maintainer Memory

## Project: nest-server

### Package Manager
- Uses **pnpm** (pnpm-lock.yaml)
- Use `pnpm add`, `pnpm remove`, `pnpm install`

### Blocked Updates (documented, re-verified 2026-07-15)
- `@getbrevo/brevo` 3.x → 6.x (now 6.0.2): Complete API redesign (TransactionalEmailsApi, SendSmtpEmail, TransactionalEmailsApiApiKeys removed). Would require rewriting `src/core/common/services/brevo.service.ts`. See `blocking-updates.md` for details.
- `graphql-upload` 15.x → 17.x: Extension changed from `.js` to `.mjs`. Import paths in `src/core.module.ts`, `src/core/modules/file/core-file.resolver.ts`, `src/server/modules/file/file.resolver.ts`, and `src/types/graphql-upload.d.ts` would all need updating.
- `graphql` 16.x → 17.x: BLOCKED. `@nestjs/graphql@13.4.2` + `@nestjs/apollo@13.4.2` peer on `graphql ^16.10.0`. Ecosystem-wide major; do not bump within NestJS 11.
- `@nestjs/swagger` 11.4.2 → 11.4.3+ (re-confirmed 2026-07-15 at 11.4.5): **STILL BLOCKED**. 11.4.5 STILL has the restrictive `exports` field exposing ONLY `.`, `./plugin`, `./package.json` (verified via `pnpm view @nestjs/swagger@11.4.5 exports`). Breaks: test `tests/project.e2e-spec.ts` runtime value import `import { DECORATORS } from '@nestjs/swagger/dist/constants'` (the `src/` deep import in `unified-field.decorator.ts` is `import type`, erased — only the test's value import actually breaks). Tests must not be modified → KEEP at 11.4.2 until upstream re-exposes the subpath or the test import is replaced with a public re-export.
- `typescript` 5.x → 7.x (now 7.0.2, skips "6"): Ecosystem readiness unknown — skip until NestJS/tools explicitly support it.
- `ts-morph` 27.x → 28.x: blocked ONLY by `@compodoc/compodoc@1.2.1` (deps `ts-morph@^27.0.2`). **`@compodoc/compodoc@2.0.0` deps `ts-morph@^28.0.0`** (verified 2026-07-15) → upgrading compodoc to 2.0.0 would unblock ts-morph 28. `@nestjs/graphql@13.4.2` peerDep already allows `^28.0.0`. ts-morph is a RUNTIME dep (permissions-scanner.ts), so the 28 bump still needs its own eval even after compodoc unblocks it.
- `@compodoc/compodoc` 1.2.1 → 2.0.0: MAJOR dev-only (docs generator; NOT in build/test/check/lint pipeline, only `pnpm run docs`). engines node ^20.19||^22.12||>=24 (OK). Would unblock ts-morph 28 AND make the `uuid` override removable (compodoc 2.0.0 deps `uuid@14.0.1` natively vs 1.2.1 pulling vulnerable uuid). Flagged, not applied (conservative). Good reviewed follow-up.
- `ejs` 5.x → 6.x: MAJOR runtime dep (template.service.ts + better-auth email verification — email/password-reset templates, critical path). Flag; verify template rendering before adopting.
- `@types/node` 25.x → 26.x: MAJOR dev types, ahead of the Node 24 runtime + `engines >=22`. Flag; risk of speculative type errors.
- `mongodb` 7.2.0 → 7.5.0: BLOCKED by mongoose coupling (see Version Coupling below).

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
- `mongodb` and `mongoose` must be updated TOGETHER. Mongoose declares `mongodb` as a dependency (`dependencies.mongodb`), so a direct `mongodb` pin that diverges from mongoose's range creates a version split (direct copy vs mongoose's nested copy) → ObjectId `instanceof` failures etc.
- Current (2026-07-15): mongodb@7.2.0 + mongoose@9.7.4 (mongoose bumped 9.6.2→9.7.4 this session; minor, safe).
- **`mongoose@9.7.4` still requires `mongodb@~7.2`** (>=7.2.0 <7.3.0). The only STABLE release in that range is `7.2.0` (7.2.x prereleases are dev-only). So `mongodb` is pinned at 7.2.0. **`mongodb@7.5.0` is available but COUPLING-BLOCKED** — cannot bump until mongoose's `mongodb` range moves past ~7.2.

### Overrides location + Status (updated 2026-07-15)
- **IMPORTANT: overrides live in `pnpm-workspace.yaml` (`overrides:` block), NOT `package.json` `pnpm.overrides`.** pnpm 11 stopped reading the `pnpm` field in package.json. `allowBuilds`, `nodeLinker`, `autoInstallPeers`, `strictPeerDependencies`, `peerDependencyRules` are all in `pnpm-workspace.yaml` too. (The long stale list of ~15 overrides that was here previously — axios/minimatch/undici/handlebars/kysely/path-to-regexp/lodash/etc — no longer exists; it was pruned during the pnpm 11 migration.)
- Empirical method (reliable): remove candidate overrides → `pnpm install` → `pnpm audit` is the arbiter. If a vuln reappears, the override is load-bearing; if audit stays clean AND the pkg resolves to a safe version, it was a no-op → remove. `autoInstallPeers: false`, so watch for optional-peer packages.
- **CURRENT SET = 6 (down from 9 this session):**
  - `ajv@>=7.0.0-alpha.0 <8.18.0` → `8.18.0`: KEEP (ReDoS floor, transitive via @nestjs/cli>@angular-devkit)
  - `picomatch@>=4.0.0 <4.0.4` → `4.0.4`: KEEP (ReDoS floor)
  - `ws@>=8.0.0 <8.21.0` → `8.21.0`: KEEP (GHSA-96hv-2xvq-fx4p, 8.x floor; note ws is now ALSO a direct dep)
  - `uuid@<14.0.0` → `14.0.0`: KEEP (GHSA-w5hq-g745-h8pq buffer bounds; @compodoc/compodoc@1.2.1 pulls vulnerable uuid — removable once compodoc→2.0.0)
  - `@babel/core@<7.29.6` → `7.29.6`: KEEP (GHSA-4x5r-pxfx-6jf8 arbitrary file read; without it compodoc's babel chain resolves @babel/core to **7.28.6**, vulnerable — empirically confirmed 2026-07-15)
  - `js-yaml@<4.2.0` → `4.2.0`: KEEP (GHSA-h67p-54hq-rp68 quadratic-complexity merge-key DoS; without it resolves to **4.1.1**, vulnerable; 4.1.2 unpublished so 4.2.0 is min fix; via @nestjs/swagger + @compodoc/compodoc)
- **REMOVED 2026-07-15 (empirically confirmed no-op after this session's direct-dep updates):**
  - `nodemailer@<9.0.1` → `9.0.1`: was actively patching the DIRECT dep (package.json declared nodemailer `8.0.8`!). Bumped direct nodemailer → 9.0.3, no transitive nodemailer → override no longer does anything.
  - `multer@<2.2.0` → `2.2.0`: `@nestjs/platform-express@11.1.28` now pins `multer@2.2.0` exactly; direct dep also bumped 2.1.1→2.2.0 → override no-op.
  - `vite@>=8.0.0 <8.0.16` → `8.0.16`: direct vite bumped 8.0.14→8.1.4, all vite resolves to 8.1.4 → override no-op.

### json-to-graphql-query in dependencies (not devDependencies)
- Used in `src/test/test.helper.ts` which is EXPORTED via `src/index.ts`. Must remain in `dependencies`.

### Do NOT remove — depcheck false positives (verified 2026-07-15)
- `@as-integrations/express5` (dependency): depcheck flags it as unused, but `@nestjs/apollo`'s `apollo-base.driver.js` `loadPackage('@as-integrations/express5', ...)` `require`s it at RUNTIME to serve GraphQL over Express 5. It is an OPTIONAL peer of `@nestjs/apollo` (`peerDependenciesMeta`, not in `peerDependencies`), and this project has `autoInstallPeers: false` → it will NOT be auto-installed if removed. MUST stay a direct dependency.
- `@nestjs/schematics` (dev): used via `nest-cli.json` `collection`. `husky` (dev): `.husky/` hooks. `rimraf` (dev): 6× in package.json scripts. All KEEP.

### Runtime deps ADDED to `dependencies` (2026-07-15)
- Added 4 packages that were imported at RUNTIME by shipped/exported code but only resolved transitively (undeclared): `graphql-ws@6.0.8` + `ws@8.21.0` (both `import`/`require` in the EXPORTED `src/test/test.helper.ts` — same reasoning as the earlier supertest/json-to-graphql-query moves), `jose@6.2.1` (`importJWK`/`jwtVerify` in `core-better-auth.service.ts`), `cron@4.4.0` (`new CronJob` in `core-cron-jobs.service.ts`). Pinned to the exact transitively-resolved versions (zero resolution change; 1381 tests still green; SWC-TDZ guard clean — no new import cycles). Rationale: vendor-mode consumers + hoisting-independence. `fs-capacitor` was NOT added — its only use (`WriteStream` in `file-upload.interface.ts`) is type-only (erased at runtime).
- These 4 have newer patches/minors available (graphql-ws 6.1.0, jose 6.2.3, ws 8.21.1) but were intentionally pinned to the resolved version, not bumped — declaring, not updating.

### Environment gotchas (pnpm 11.13.0 + hoisted linker, macOS)
- **`@nestjs/cli` bin exec-bit strip:** a `pnpm install` that RE-LINKS `@nestjs/cli` can leave `node_modules/@nestjs/cli/bin/nest.js` WITHOUT the executable bit → `nest build` dies with `sh: .../.bin/nest: Permission denied` (exit 126). It's version-INDEPENDENT (the store dedups the byte-identical launcher across 11.0.21/11.0.24, so reverting the version doesn't help — same store entry). Fix: `chmod +x node_modules/@nestjs/cli/bin/nest.js` (survives subsequent `pnpm install` once the lockfile is stable). This session kept `@nestjs/cli` at 11.0.21 (baseline) so the user's next install won't re-link the build tool. `pnpm rebuild` does NOT restore the bit.
- **`oxfmt` 0.51 → 0.59 reformats markdown:** oxfmt 0.59.0 now checks/reformats `.md` files, so `pnpm run format:check` (part of `check`) FAILS on existing `src/**/README.md` (e.g. ai/README.md, better-auth/README.md). Adopting 0.59 requires a `pnpm run format` doc-reformat commit. Deferred — kept oxfmt at 0.51.0. It's a 0.x (zero-version) dev-only formatter → MEDIUM risk.
- **`oxlint` 1.66 → 1.74:** applied. lint PASSES (exit 0) but emits ONE new non-blocking warning: `import(namespace): "render" not found in imported namespace "ejs"` at `core-better-auth-email-verification.service.ts:219` — a static-analysis limitation on ejs's CJS/ESM interop (`ejs.render` is a real function). Not a failure; `lint` has no `--deny-warnings`.

### Key Files
- `/Users/kaihaase/code/lenneTech/nest-server/package.json` - main package config
- `/Users/kaihaase/code/lenneTech/nest-server/src/core/common/services/brevo.service.ts` - uses @getbrevo/brevo v3 API
- `/Users/kaihaase/code/lenneTech/nest-server/src/types/graphql-upload.d.ts` - custom type declarations for graphql-upload
