---
name: optional-peer-vendor-delivery
description: How a NEW optional peer that src/core dynamically imports reaches vendor projects — CLI import-closure scan at conversion, migration guide only for agent updates; vendor-runtime-deps.json is NOT the mechanism
metadata:
  type: project
---

A new optional peer the core lazy-imports (`await import('@aws-sdk/…')`, `ioredis`, `bullmq`,
`@tus/s3-store`) does NOT need an entry in the lt CLI's `src/config/vendor-runtime-deps.json`, even
though CLAUDE.md's vendor note reads as if every runtime-used peer must be listed there.

**Why:** verified 2026-10-03 (11.41.7, `@aws-sdk/lib-storage`) in two places:
- **Fresh conversion:** `gatherVendorCoreImportClosure()` in `cli/src/extensions/server.ts` scans every
  vendored `.ts` with ts-morph, including dynamic `import('x')` calls with a string literal, and adds
  each missing package at the EXACT version from the upstream `pnpm-lock.yaml` `packages:` section.
  `typeof import('x')` type references are NOT scanned, but in practice the same file also has the
  dynamic call. None of `client-s3`, the presigner, `ioredis` or `bullmq` is in `runtimeHelpers`.
- **Existing vendor project, agent update:** `nest-server-core-updater` Phase 7b only raises deps the
  project ALREADY lists, plus `runtimeHelpers`. A brand-new peer is therefore never added
  automatically. The tsc in Phase 8 fails loudly with TS2307, and the migration guide's vendor
  instruction is the only thing that names the fix. Precedent: 11.33 handled `client-s3` the same way.

Listing an optional peer in `runtimeHelpers` would promote it with the upstream PEER RANGE
(`>=3.1045.0 <4`), not the pin, and for `@aws-sdk/lib-storage` that peers `client-s3 ^<own version>`
this risks a peer mismatch against the closure-scan's exact `client-s3`.

**How to apply:** when a diff adds an optional peer, check two things. (1) The guide has an explicit
vendor-mode "install it" line, since vendor typechecks need it even without the feature. (2) The
package is in the upstream lockfile `packages:` section. Do not flag a missing CLI
`vendor-runtime-deps.json` entry. In npm mode, `.d.ts` references to an optional peer are harmless
because the starter uses `skipLibCheck: true`. Related: [[vendor-mode-atomic-file-set-check]].
