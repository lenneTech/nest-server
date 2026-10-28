---
name: vendor-type-imports-need-the-package
description: An optional peer the core reaches only through `import type` is still a COMPILE dependency of every vendor-mode project — "a PostgreSQL project installs none of MongoDB's packages" is false there; probe recipe and the probe that does NOT work
metadata:
  type: project
---

Vendor-mode projects compile `src/core/**` as their own source (`tsc -p tsconfig.build.json` in the starter), so
`skipLibCheck` does not cover it. An `import type { Connection } from 'mongoose'` in the core is a TS2307 there when
the package is not installed, exactly like a value import. npm mode is different: the same imports sit in `dist/*.d.ts`,
which the starter's `skipLibCheck: true` skips.

**Measured 2026-10-28 (12.1.0, db-agnostic phase 5):** ~74 core files carry `import type` from `mongoose` / `mongodb` /
`@nestjs/mongoose`. Vendor file set without the three packages: 128 errors (91 TS2307); same set with them: 0. Reported
High against CLAUDE.md ("a PostgreSQL vendor project needs `pg` plus its engine instead") and
docs/choosing-a-database.md ("none of MongoDB's packages"). The lt CLI closure scan (`gatherVendorCoreImportClosure()`)
counts `import type` declarations too, so today's conversion re-adds them to `dependencies` anyway; the trap is a CLI
ticket that follows the doc and excludes them.

**Probe recipe (works):** copy `src/core`, `src/test`, `src/types`, `src/index.ts`, `src/core.module.ts` plus
`tsconfig.json` + `tsconfig.vendor-commonjs.json` into a scratch dir; build `node_modules` from symlinks to every repo
`node_modules/*` entry EXCEPT the packages under test (`@nestjs/*` and `@types/*` per entry); run
`npx --no-install tsc -p tsconfig.vendor-commonjs.json`. Re-add the symlinks for the baseline (must be 0 errors).

**Probe that does NOT work:** a scratch tsconfig `extends`-ing the repo config with `paths` mapping the package to a
missing file — TypeScript falls back to node_modules lookup when a `paths` target does not exist, and resolution of a
repo file always walks up to the repo's own `node_modules`. 0 errors, proves nothing.

**How to apply:** whenever a diff makes a package optional "because only types are imported", check the vendor half.
Related: [[optional-peer-vendor-delivery]], [[db-agnostic-phase0-doc-facts]], [[executable-doc-recipes]].

**Status:** FIXED 2026-10-28 — CLAUDE.md, docs/choosing-a-database.md, README and the 12.1 migration guide say a PostgreSQL vendor project keeps the trio as `devDependencies`.
