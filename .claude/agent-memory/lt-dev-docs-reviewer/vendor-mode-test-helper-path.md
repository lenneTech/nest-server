---
name: vendor-mode-test-helper-path
description: Vendoring moves src/test to <api>/src/core/test — any doc recipe that probes src/test/test.helper.ts to detect "does this project have helper X" silently misses every vendor-mode project
metadata:
  type: project
---

The CLI's vendoring copies `src/test` to `${srcDir}/core/test` (cli `src/extensions/server.ts`, the
copy list next to `src/core.module.ts`). So in a vendor project the TestHelper is
`src/core/test/test.helper.ts`, its README `src/core/test/README.md` — never `src/test/…`.

**Why:** 2026-10-06 lt-dev `mcp-integration.md` added a feature probe
`grep -l mcpSession node_modules/@lenne.tech/nest-server/src/test/test.helper.ts src/test/test.helper.ts`
justified "because src/test/ is copied into vendor-mode projects" — and both paths miss the vendor
location, so the check fails in exactly the case it was written for (agent falls back to hand-rolled
supertest helpers and tells the user to update nest-server).

**How to apply:** whenever a plugin/doc recipe detects a framework capability by path, check both
modes: npm `node_modules/@lenne.tech/nest-server/src/<x>` and vendor `src/core/<x>` (core files) /
`src/core/test/<x>` (test helper). The generating-nest-servers SKILL "vendored mode" substitution
table maps only `src/core/`, not `src/test/`, so agents will not infer it.

Related: [[vendor-mode-atomic-file-set-check]], [[optional-peer-vendor-delivery]]
