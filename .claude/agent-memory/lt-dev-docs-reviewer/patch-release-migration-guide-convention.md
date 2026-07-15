---
name: patch-release-migration-guide-convention
description: nest-server ships a migration guide for EVERY patch release incl. zero-effort internal bugfixes — the observed convention is stricter than the written rule in .claude/rules/migration-guides.md
metadata:
  type: project
---

`.claude/rules/migration-guides.md` says a guide is "Not required if purely internal bugfixes with no user action needed". **The repo's actual practice contradicts this**: `migration-guides/` has an unbroken chain for every patch in the 11.27.x line (11.27.0→.1→.2→.3→.4→.5→.6), including guides whose own Overview says *"Migration Effort: 0 minutes (automatic) — `pnpm update` is enough"* and *"No source-code or config changes are required in consuming projects"* (see `11.27.2-to-11.27.3.md`, a pure internal unhandled-rejection fix, and `11.24.0-to-11.24.1.md`).

**Why:** Consumers use the guides as the release-notes surface, not just as migration instructions. A guide for a "silent" bugfix still earns its keep when the bug had a *user-visible symptom* — the reader who googles the crash/error string needs to land on "fixed in vX". Grading "no guide needed, it's just a bugfix" as 100% N/A therefore under-reports.

**How to apply:** When a branch is a pure internal bugfix, do NOT auto-grade the migration-guide dimension as N/A. Ask: (1) did the bug have a symptom a consumer could observe (startup crash, 401, error string)? (2) does the fix require anything of **vendor-mode** consumers, who never run `pnpm update` and instead sync `src/core/` via the `lt-dev:nest-server-core-updater` agent — e.g. a multi-file atomic change where a partial sync breaks the build? If either is yes, a guide is warranted.

**Timing nuance (do not mis-attribute):** release commits are titled `11.27.X: <summary>` and bundle the version bump + migration guide + FRAMEWORK-API regen. Feature/fix branches use conventional commits (`fix(better-auth): …`) and leave `package.json` version alone. So "no version bump / no guide on a fix branch" is *normal*; flag the guide as a **release-time deliverable**, not a branch blocker. See [[framework-api-generator-allowlist]] and [[doc-surfaces-for-config-features]].
