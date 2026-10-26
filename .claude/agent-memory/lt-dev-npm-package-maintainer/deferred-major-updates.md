---
name: deferred-major-updates
description: Updates deliberately NOT taken in nest-server and why — state 2026-10-24 (12.0.0): vite held at 8.3.4 (vitest 5.0.5 #11682 crash), graphql-upload 17 planned for 12.1.0 (needs the GraphQLUpload re-export adopted first), undici 8 BLOCKED (hijacks Node's built-in fetch dispatcher on load), graphql 17 + TS 7 blocked by peers, ws/graphql-ws/express/multer locked to NestJS 12 pins; ts-node REMOVED in 12.0.0 (own @swc/core loader, do not re-add)
metadata:
  type: project
---

# Deferred updates in `@lenne.tech/nest-server` (state 2026-10-24, 12.0.0)

**Why this note exists:** this repo IS the framework. Whatever it pins becomes the pin every downstream project
inherits (`pnpm run update` in a starter-based project raises shared pins to the framework's), so a deferral is a
decision with a reason, not an oversight. When a run reports one of these as "outstanding", re-check the reason —
take it only when the reason is gone. The full run-by-run log up to 2026-10-24 is in git
(`git log -p .claude/agent-memory/lt-dev-npm-package-maintainer/deferred-major-updates.md`).

## Currently deferred

| Package | Pinned | Available | Reason — and what lifts it |
|---|---|---|---|
| `graphql-upload` | 15.0.2 | 17.1.0 (18 needs graphql 17) | 16+ exports only `.mjs` subpaths, so every project importing `graphql-upload/GraphQLUpload.js` breaks, with no way to prepare under 11.x — and `check:consumer` (publish gate) runs against the starter's DEFAULT branch, which still imports `.js`. Two copies are not an option: the scalar checks `instanceof Upload` against its own copy, the middleware creates them from nest-server's. 12.0.0 therefore adds the root export `GraphQLUpload` (`src/core/common/scalars/upload.scalar.ts`); once the starter imports the scalar from `@lenne.tech/nest-server`, take 17.1.0 in **12.1.0**: change `core.module.ts` (`graphqlUploadExpress.mjs`, default import), `upload.scalar.ts` (`GraphQLUpload.mjs`, default import — NOT `import = require`, which yields the namespace under require(esm)), `src/types/graphql-upload.d.ts` (`.mjs` module names, `export default`), and drop `peerDependencyRules.allowedVersions '@types/express'` (17 peers `^4 \|\| ^5`). Verified 2026-10-24: under CJS, `__importDefault(require('…GraphQLUpload.mjs'))` works (Node sets `__esModule` on a require(esm) namespace with a default export) and the scalar is from the same `graphql` realm (graphql 16 has no exports map, ESM import resolves index.js). 17.1.0 also fixes a hang on aborted multipart requests |
| `undici` | 7.30.1 | 8.12.3 | **BLOCKED.** Loading undici 8 replaces the global dispatcher of Node's BUILT-IN `fetch` (Dispatcher1Wrapper): afterwards `fetch(url, { method: 'POST', headers: { 'Content-Length': '0' } })` anywhere in the process fails with `UND_ERR_INVALID_ARG`; 7.30.1 leaves it alone. Reproduced on Node 24.12 (probe: start an http server, call fetch, `require('undici')`, call again). nest-server loads it via `outbound-url.helper.ts`, so every consumer's process would be affected (the starter's tus e2e went 16/125 red). Also needs Node >= 22.19 (floor 22.15). 7.x still gets security patches (7.30.1, 2026-10-15). Re-run the probe on each new 8.x |
| `graphql` | 16.14.2 | 17.0.2 | `@apollo/server` 5 (latest) peers `^16.11.0`, `graphql-subscriptions` 3 (latest) `^15.7.2 \|\| ^16` |
| `typescript` | 6.0.3 | 7.0.2 | `@nestjs/graphql` 14 and `@nestjs/swagger` 12 peer `^5.5 \|\| ^6`; `@nestjs/schematics` 12 wants `>=6` |
| `graphql-ws` / `ws` | 6.3.0 / 8.22.0 | 6.4.1 | LOCKSTEP with `@nestjs/graphql` 14.0.3's exact pins — a direct bump alone puts a second copy into every consumer tree |
| `express` / `multer` | 5.3.0 / 2.5.0 | — | `express` = `@nestjs/platform-express` 12.2.0's exact pin; `multer` one patch ABOVE its pin (2.4.0, GHSA-q7qp) via override + direct dep in lockstep |
| `better-auth` trio | devDeps 1.7.13 (since 2026-10-27), peers `>=1.7.12 <1.8.0` | 1.8.0 beta only | Wire-critical: move in LOCK-STEP with nuxt-extensions and both starters (peer ranges byte-identical in both frameworks). The floor moved to 1.7.12 on 2026-10-24 by owner decision (1.7.12 verifies JWTs with the stored key's algorithm). A maintenance run reports, never moves them alone |
| `vite` (dev) | 8.3.4 | 8.3.5 | **BLOCKED by vitest 5.0.5** (vitest-dev/vitest#11682): vitest reads globalSetup/reporter modules as a Buffer, vite 8.3.5 calls `charCodeAt` on it when mapping a stack — any `.stack` read in the main process throws, the run exits 1 after green tests (MongoDB monitor in the DB reporter's close(), 1 run in 3). Guard `tests/unit/toolchain-compat.spec.ts`. Lift: a vitest release after 5.0.5, then raise vite and delete the spec |
| `pnpm` (`packageManager`) | 11.28.5 | 12.x | Never from a maintenance run (contract test `tests/unit/pnpm-pin-contract.spec.ts`) |

**Taken later on 2026-10-24, once each cleared the 1440-min gate:** mongoose 9.11.4 (prototype-pollution
hardening), `@modelcontextprotocol/sdk` 1.32.2, `@tus/s3-store` 2.0.9, bullmq 6.4.1 (pulls msgpackr 2.1.0 -> 2.1.2).

**Taken 2026-10-27 (pre-12.0.0 run):** `@nestjs/swagger` 12.0.4 (UI asset fix, deps unchanged), bullmq 6.4.2 (dev),
better-auth trio 1.7.13 as devDependency TEST pins only (peer range `>=1.7.12 <1.8.0` untouched; 1.7.13 = type
declarations no longer list type-only exports as values, no security fix), plus 20 sticky transitives lifted to the
fresh-resolve versions (incl. follow-redirects 1.16.2, see [[nest-server-maintenance-gotchas]]). Re-verified the
same day: @nestjs/graphql 14.0.3 is still the newest and still pins graphql-ws 6.3.0 / ws 8.22.0 / utils 12.0.1;
platform-express 12.2.0 still pins multer 2.4.0; vitest has no stable after 5.0.5 (5.1.0-beta.1 only), so vite
stays 8.3.4.

**Next run:** better-auth trio 1.7.14 (TOTP base32 import fix, Kakao loginHint; not security), AWS trio 3.1157.0,
bullmq 6.5.0 (a MINOR) — all published 2026-10-26 evening, inside the gate on 2026-10-27.

**Deprecated transitives without a fix:** `lodash.get` (via `graphql-query-complexity` 2.0.0, the newest — runtime,
works), `whatwg-encoding` (via `@compodoc/compodoc` > `cheerio` 1.2.0 > `encoding-sniffer` 0.2 — dev only).

## Taken on 2026-10-24 (12.0.0), for reference

**ts-node REMOVED (12.0.0, owner decision 2026-10-24).** `src/core/modules/migrate/helpers/ts-compiler.js` is an
own `@swc/core` require hook now (same path, same `--compiler ts:` contract); nodemon, `nodemon-debug`, `docs:ci`
and `bin/migrate.js`'s source branch use it. `@swc/core` became an OPTIONAL peer (`>=1.10.0 <2`) and stays a
devDependency. Rejected: `@swc-node/register` (peer `typescript <7`, crashes on TS 7, whose root export is only
`version.cjs`), tsx/esbuild and Node type stripping (no decorator metadata). Do not re-add ts-node; `tsx` stays
for decorator-free scripts (`build:framework-api`, two spec fixtures). Pinned by `tests/unit/ts-compiler.spec.ts`.

NestJS 12 family + TypeScript 6 (owner), `vitest` + `@vitest/coverage-v8` 5.0.5 (unit + e2e green, all 166
infra-free mutations confirmed, `check-mutations.mjs` parses vitest 5's summary; `disableConsoleIntercept` still
needed — `$rejectPendingCalls` teardown race unchanged in 5.0.5), dotenv 18, ejs 7 (call sites use
`ejs.compile(src)(data)`, unaffected by the options-in-data removal), better-auth 1.7.12, nodemailer 10.2.1,
`pnpm update --depth Infinity` (kysely 0.28.17 -> 0.29.7 among ~100 transitive moves). Removed as dead:
`tsconfig-paths` (tsconfig declares no `paths`), `vite-plugin-node` + `vite.config.ts` (no script runs vite;
`vite` itself stays as vitest's peer), `npm-watch` (unmaintained; `pnpm run watch` now calls `nodemon` directly).

## Durable lessons

- **A security advisory with no in-major fix bends the "no runtime major in a maintenance run" rule** (nodemailer
  9 -> 10 in 11.41.5). Find it at the START of a run (`pnpm audit` before anything else) and surface it — the
  orchestrator decides, not the maintainer.
- **A security patch outranks a stale comment** (vitest 4.1.12, 2026-10-17: repository advisories on
  `@vitest/mocker` not yet in the global DB). Read release notes; see [[nest-server-maintenance-gotchas]] for
  repo-level advisories that `pnpm audit` cannot see.
- **A consumer-facing side effect is a blocker even when every suite here is green** (undici 8): our suites do not
  exercise the built-in `fetch` with an explicit `Content-Length: 0`; the starter's tus e2e did. When a runtime
  dependency major lands, ask what it does on LOAD, not only what its API changed.
- **Discovery:** a script reading the registry `time` per direct dependency (newest mature in-major, pending in
  cooldown, available majors) replaces `ncu`, which ignores `minimumReleaseAge`. Check 0.x packages separately
  (a 0.x minor is a semver major).
- **oxfmt bumps can reformat SHIPPED READMEs in `src/`**: run `oxfmt --check src/ scripts/` on the new version
  before taking it in a run that must not touch `src/`.

Related: [[nest-server-override-status]], [[nest-server-maintenance-gotchas]], [[starter-downstream-maintenance]]
