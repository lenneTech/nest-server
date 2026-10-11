---
name: windows-unit-job-path-separators
description: nest-server's Windows CI job runs the whole UNIT suite (expected green, continue-on-error hides red); any new structural spec comparing path.relative() output to '/' literals fails there and nowhere a local check can see
metadata:
  type: project
---

`.github/workflows/windows.yml` runs `pnpm run vitest:unit` on `windows-latest`. It is documented as
"Expected GREEN" but `continue-on-error: true` makes the WORKFLOW report `success` either way — read
the JOB / "Unit tests" step conclusion: `gh run view <id> --json jobs`.

**The recurring shape:** a structural spec (reads `src/` with `readdirSync` + `join`) that compares
`relative(ROOT, file)` against forward-slash literals. On Windows `node:path` is `path.win32`, so the
value is `src\core\...` and `toEqual([...'/'...])` fails deterministically. Every established sibling
normalises: `relative(ROOT, file).split(sep).join('/')` (regression-evidence, test-file-placement,
test-file-routing, dev-scripts). Found 2026-10-11 in the new `auth-cookie-secure-wiring.spec.ts`
(both cases red on Windows, green on macOS/Linux and in `check`).

**Why:** `pnpm run check` on a Mac and the Linux CI are both blind to it, and the Windows job's green
status is the only thing telling anyone a new red is new (it sat red unnoticed for nine days once).

**How to apply:** for every NEW `tests/unit/*.spec.ts` that builds file paths, grep for `relative(`
and literal `'src/...'` comparisons; demonstrate with
`node -e "const p=require('node:path').win32; ..."` rather than claiming it. Related:
[[check-gate-coverage-blind-spots]].
