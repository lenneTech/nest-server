---
name: audit-suppression-has-no-rule-doc-home
description: RESOLVED 2026-09-03 — ignoreGhsas policy now has a rule-doc section and package-management.md points at check:overrides; keep the pointer alive when the guard changes
metadata:
  type: project
---

`pnpm-workspace.yaml` → `auditConfig.ignoreGhsas` is the repo's advisory-suppression
mechanism. Until 2026-09-03 its entire policy — when an entry is allowed, and that a
suppressed GHSA vanishes from `pnpm audit --json` so nothing ever re-reports it — existed
ONLY as a comment inside that YAML file. `.claude/rules/package-management.md` enumerated
the pnpm-workspace keys (`overrides`, `allowBuilds`, `nodeLinker`, `peerDependencyRules`)
and never mentioned `auditConfig`, while its "Overrides AGE" section taught a purely MANUAL
detection procedure with `pnpm audit` as the arbiter.

**RESOLVED on 2026-09-03.** All three gaps this note was written for are closed:

- `package-management.md` gained a "Suppressions age the same way, and worse" section with
  the four rules for adding an entry and the invisibility property.
- The "Overrides AGE" section now points at `pnpm run check:overrides`, which automates the
  three manual tells.
- The stale "9 still load-bearing" count is corrected (the file carries 17).

**Why this note is kept rather than deleted:** the gap was created by a mechanism that will
recreate it. The suppression policy is enforced by ONE script, and the rule file is the only
place a maintainer looks. If `check-overrides.mjs` changes what it detects — or is renamed,
or moved out of the check chain — the rule file becomes wrong again, silently, exactly as it
was before. `CLAUDE.md`'s Living Documentation table now carries a row for this
(`package-management.md` → "Changing the overrides set, adding or removing an
auditConfig.ignoreGhsas suppression, or changing the check:overrides guard").

**How to apply:** on a diff touching `pnpm-workspace.yaml`, `scripts/check-overrides.mjs` or
the audit chain, verify the rule file still describes what the guard actually does — not that
it mentions it at all, which is now true and no longer the useful question. Related:
[[release-version-artifacts]], [[number-drift-in-tooling-prose]].
