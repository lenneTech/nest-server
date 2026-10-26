---
name: project-12-0-0-esm-dist-switch
description: 12.0.0 "type":"module" dist review (2026-10-26) — migration template cwd lookup broke compiled-migration runs without NSC__MONGOOSE__URI (reported High, FIXED same day); the rest of the ESM switch probed sound.
metadata:
  type: project
---

Reviewed the 12.0.0 switch to an ESM-only dist (`"type": "module"`, CommonJS consumers via require(esm)) on 2026-10-26.

**Reported (High):** `templates/migration-project.template.ts` replaced `require('../src/config.env')` (relative to the
migration file) with `createRequire(cwd/package.json)(cwd/src/config.env)`. A COMPILED migration (`dist/migrations`,
starter `migrate:prod:up` / `dp:*`, Docker `/app`) used to load `dist/src/config.env.js`; now it finds only
`src/config.env.ts` or nothing, gets MODULE_NOT_FOUND (Node 24 does not probe `.ts` without the loader) and throws
"MongoDB URI not available" unless NSC__MONGOOSE__URI is set. The store (`mongo-uri.js`) still reads the compiled config,
so only the migration fails. Reproduced with a scratch prod layout: new template exit 1, HEAD template exit 0.
**Fixed the same day:** the template tries `__dirname/../src/config.env` (CommonJS only), `<cwd>/src/config.env` and
`<cwd>/dist/src/config.env` before the env var. Pinned in `tests/unit/migrate-cli-template.spec.ts` (compiled CJS and ESM
project, env fallback, refusal), mutation `migration-template-config-src-only`.

**Verified sound (do not re-probe from scratch):** every dist module imports as its own ESM entry (374/374, no TDZ);
barrel lost no names vs 11.43.3 (703 -> 711); no top-level await; all lazy `import()` peers expose the names used
(ioredis falls back to `.default`, @aws-sdk/bullmq have no exports map -> CJS build via lexer, names detected); namespace
imports of CJS packages (bcrypt, dotenv, mongodb, graphql) resolve; npm-mode `migrate up` from a CJS project works on
Node 22.22 and 24.12 (bin/package.json CJS, ts-compiler.js CJS, require(esm) of barrel, same helper instance for the
deep forwarder path, `callerDirectory(1)` resolves against the migration through the namespace re-export).
The forwarder `helpers/migration.helper` imported FROM ESM exposes names only on `default` (lexer cannot follow
`__exportStar(require(esm))`) — edge, not reported.

**How to apply:** probes live best in the scratchpad with a `node_modules/@lenne.tech/nest-server` symlink to the repo;
drop `review-probe-*` DBs afterwards. Related: [[review-tree-is-shared-and-mutable]], [[project-12-0-0-native-password-routes]].
