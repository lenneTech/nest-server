---
name: vendor-legacy-ts-node-bootstrap
description: Vendor projects carry a CLI-generated ts-node bootstrap in migrations-utils/ts-compiler.js that no core update touches; a 12.x core breaks every migrate:* run through it
metadata:
  type: project
---

Every vendor-mode project converted by lt CLI <= 1.51.5 has `migrations-utils/ts-compiler.js` =
a plain `ts-node.register({ module: 'commonjs', … })` bootstrap (exact text: `LEGACY_VENDOR_TS_COMPILER`
in cli `src/lib/heal-vendor-migrate-store.ts`). The vendor store (`migrations-utils/migrate.js`) requires
it whenever `src/core/…/helpers/migration.helper.js` does not exist, i.e. in every repo checkout.
`/lt-dev:backend:update-nest-server-core` rewrites only `src/core/**`, so the file survives a core sync.

With the 12.0.0 core it fails, reproduced 2026-10-26 in a scratch vendor layout:
- commonjs tsconfig: `Cannot find module '../migration.helper.js'` (ts-node maps no `.js` -> `.ts`);
- nodenext tsconfig (what guide §2 recommends): `TS5110`; without `rootDir`: `TS5011`.
Only when `bin/migrate.js` falls back to the CLI SOURCE (project never built) is the core loader's
resolver patch registered first — so "migrate:* passed for me" usually means an unbuilt checkout.
Fix: one line `module.exports = require('../src/core/modules/migrate/helpers/ts-compiler.js');`, or the
CLI's new `templates/vendor-scripts/ts-compiler.js` via `lt fullstack update` (heal, uncommitted 2026-10-26).

**Why:** the 12.0.0 guide (§14) said vendor `migrate:*` pass and "the scripts need no edit" — reported High,
fixed the same day: Quick Migration, §14 ("The migration bootstrap: REQUIRED in vendor mode"), a compatibility row
and two troubleshooting rows now carry the one-liner. Re-check that wording if the CLI heal ships under other terms.
**How to apply:** on any core-loader / module-format change, check what the vendor-side scaffolding
(`migrations-utils/*`, `bin/`, nodemon) still loads; core-sync never revisits it. See [[vendor-mode-atomic-file-set-check]].

Side fact: ts-node + `allowJs` (starter tsconfig) throws ERR_REQUIRE_ESM on the ESM 12.x package when it
is LINKED (realpath outside `node_modules`, not ts-node-ignored); an installed copy loads fine.
