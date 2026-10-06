---
name: paired-override-patch-exit-conditions
description: An override+patchedDependencies pair has TWO delete-conditions; guides merge them into one. Plus a 30-second pnpm recipe to prove the patch-file error strings a guide quotes
metadata:
  type: project
---

When a security override is paired with a shape-restoring patch (first case: nuxt-base-starter
2.30.0, `simple-git: 4.0.2` + `patches/simple-git@4.0.2.patch` restoring the default export
@nuxt/devtools imports), the two have DIFFERENT exit conditions:

- the PATCH can go once the consumer uses the named import;
- the OVERRIDE can go only once the consumer no longer resolves the vulnerable major. simple-git
  3.36.0 already exports `simpleGit` by name, so "devtools switched to `{ simpleGit }`" does NOT
  mean 3.x left the tree.

The 2.30.0 guide draft said "Delete both once @nuxt/devtools imports `{ simpleGit }`", which
contradicted the template's own yaml comment ("once nuxt requests a @nuxt/devtools that no longer
depends on simple-git 3"). `pnpm audit` in `check` would catch the reopened criticals, but a guide's
exit condition for a security control must match the source comment.

**Why:** guides compress; the yaml comment and the patch comment each carry one half of the rule.
**How to apply:** for any paired override+patch, read BOTH comments and check that the guide's
delete-condition names the vulnerable range, not the import shape.

Verification recipe (pnpm 11, no download needed, verified 2026-10-06): copy `package.json`,
`pnpm-workspace.yaml`, `pnpm-lock.yaml` into the scratchpad WITHOUT `patches/`, run
`pnpm install --frozen-lockfile --ignore-scripts` -> `ENOENT … open '<dir>/patches/<pkg>.patch'`
(hashed in `_install` before any fetch). Add the patch, move the override to another version, run
`pnpm install --lockfile-only` -> `[ERR_PNPM_UNUSED_PATCH] The following patches were not used`.
Node's error for the missing default export: `SyntaxError: The requested module 'simple-git' does
not provide an export named 'default'` (symlink the unpatched package into a scratch
`node_modules`). See also [[migration-guide-behavior-change-count-trap]].
