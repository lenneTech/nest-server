---
name: vendor-mode-atomic-file-set-check
description: Any NEW file under src/core/ that an existing core file imports is a partial-vendor-sync hazard — the migration guide must enumerate EVERY such atomic file set, not just the headline one
metadata:
  type: project
---

Vendor-mode consumers copy `src/core/` into their tree and sync via the `lt-dev:nest-server-core-updater` agent, file by file — not via `pnpm update`. So **every new file under `src/core/` that an existing core file imports creates an atomic file set**: if the sync takes the edited importer but not the new leaf, the consumer gets an unresolvable import and a broken build.

**How to apply:** For each branch, list new files under `src/core/` (`git diff <base>...HEAD --diff-filter=A --name-only -- src/core/`) and, for each, grep which existing core files now import it. Every such cluster needs a row in the guide's vendor-mode section. Then re-count the guide's own claim — it has been wrong.

**Why (concrete):** The 11.27.7 guide documented exactly one atomic set (BetterAuth), titled it *"the change is an atomic 4-file set"* while its own table listed **6** files, and omitted two further sets entirely:
- **core helpers:** `id.helper.ts` (new) + `clone.helper.ts` (new) + `db.helper.ts` + `input.helper.ts` + `restricted.decorator.ts` + `config.service.ts` — `db.helper.ts` now does `export { equalIds, … } from './id.helper'`, so taking db.helper without id.helper breaks the build. Identical hazard to the one the guide *did* warn about.
- **filter inputs:** `filter.input.ts` + `combined-filter.input.ts` (the latter is now a re-export shim).

Two independent count/coverage errors in one guide's vendor section — treat this section as high-suspicion by default. Related: [[migration-guide-behavior-change-count-trap]], [[patch-release-migration-guide-convention]].
