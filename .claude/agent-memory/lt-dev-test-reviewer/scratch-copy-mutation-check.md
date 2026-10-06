---
name: scratch-copy-mutation-check
description: How to prove an UNREGISTERED defect-pinning test goes red without touching the reviewed working tree (rsync copy + symlinked node_modules), and the regression-evidence gate that peer sessions trip with a bare @regression block
metadata:
  type: reference
---

When a review is "report only, do not modify files" and a test claims to pin a defect but has no
registered mutation, `check:mutations` cannot be used (it needs a registry entry and edits the tree).
What worked (2026-10-06, generated-secret story):

- `rsync -a --exclude node_modules --exclude .git --exclude dist --exclude coverage ./ <scratchpad>/nsc/`
  (~13 MB), then `ln -s <repo>/node_modules <scratchpad>/nsc/node_modules`.
- Run the unmutated file FIRST in the copy to prove the setup is sound, then apply the mutation with
  `sed -i ''` and re-run with `--retry=0`.
- E2E single file: `LT_TEST_INFRA=0 NODE_ENV=e2e npx vitest run --config vitest-e2e.config.ts <file>`
  (call vitest directly, see [[single-e2e-file-run-gotcha]]). ~2 s per run; the failing run left no
  stray run DB behind. Delete the copy afterwards.
- nuxt-base-template copy also needs the generated `.nuxt/` (setup.ts transform reads
  `.nuxt/tsconfig.json`), ~1.6 MB. lt-monorepo needs only `scripts/` + `package.json` (node --test).
- vitest 5 `--reporter=json` WRITES `.vitest/json/output.json` into the repo it runs in — an
  untracked artifact in a "do not edit" tree. Use `--reporter=verbose` + grep, or delete it after.

**Why:** a green test looks the same whether it checks something or nothing; the copy gives the
"show me it red" evidence the repo rule demands without colliding with the author's live tree.

**Related gate:** `tests/unit/regression-evidence.spec.ts` scans every `/** … */` block containing
`@regression` and FAILS if it lacks `@seen-failing` naming a registered mutation. Peer sessions writing
a prose-style `@regression` block (with measured mutations described but not registered) turn `check`
red. Registering the mutations also moves the documented totals pinned in `.claude/rules/testing.md`
and `scripts/check-mutations.mjs` (total and `--no-infra` unit-only count).
