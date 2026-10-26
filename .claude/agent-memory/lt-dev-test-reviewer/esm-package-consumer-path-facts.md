---
name: esm-package-consumer-path-facts
description: 12.0.0 made the package "type": "module"; which consumer contracts NO gate executes (require(esm) barrel, bin/ + dist helpers/ package.json, the CJS forwarder, callerDirectory's file: branch) and how to prove each cheaply
metadata:
  type: project
---

12.0.0 ships one ESM `dist/`; CommonJS projects (starter + customer projects) load it via `require(esm)`.
First review (2026-10-26) found the CommonJS-consumer half executed by no gate:

- Every in-repo gate loads the package with `import`: vitest (module runner), `check:esm` (asserts only
  `exportCount > 0`), `check:server-start` (dist/main.js is ESM). `check:swc-tdz` is a pure CJS build.
  `check:consumer --fast` (the publish gate) = typecheck + build + starter vitest, also native import.
  Only the FULL `check:consumer` (starter `check:server-start` runs `migrate:up` + CJS boot) covers it.
- Reintroducing the documented defect at dist level (migrate/index.js exporting `./helpers/migration.helper.js`):
  `require(dist/index.js)` -> 6 keys, `CoreModule` undefined; `import()` -> 707 keys.
- `rm bin/package.json`: full unit suite stays green (vitest's runner provides `require` to inlined CJS,
  ts-compiler.spec copies migrate.js to a tmp dir with no package scope); `node bin/migrate.js` ->
  `require is not defined in ES module scope`.
- `dist/core/modules/migrate/helpers/package.json` arrives only via nest-cli `"**/*.json"` (the sole JSON in src/).
- `helpers/migration.helper.ts` forwarder: zero importers in src/tests; the lt CLI's `migrate-store.js` requires it.
- vitest stack frames are plain PATHS; ESM dist frames are `file:` URLs, so `callerDirectory()`'s URL branch
  (the production branch) is unreachable from any vitest test. Cheap pin: `vm.runInThisContext(code, { filename: 'file:///…' })`.

**Closed the same day (2026-10-26):** `tests/unit/package-format-contracts.spec.ts` runs `bin/migrate.js`, the loader and
the forwarder in place in child processes; `module-format-invariants.spec.ts` refuses imports from a CommonJS scope into
the graph and top-level await; `check:manifest` (post-build in `check`) checks the packed nested manifests and compares
`require()` vs `import()` of `dist/index.js` in two fresh processes; `callerDirectory`'s `file:` branch is pinned in
`tests/unit/module-location.spec.ts`. Mutations: `barrel-imports-cjs-forwarder`, `bin-manifest-type-module`,
`nest-cli-assets-drop-json`, `migration-helper-forwarder-emptied`, `caller-directory-file-url`.

**Why:** these are the paths every consumer runs and the ones the suite is structurally blind to.
**How to apply:** when reviewing module-format / packaging changes, check whether a post-build CJS smoke step
exists before trusting a green `check`. Probe = `cp -R dist package.json` + symlinked node_modules into the
scratchpad, mutate there. Related: [[scratch-copy-mutation-check]], [[vitest-blind-to-swc-cjs-tdz]].
