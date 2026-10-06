---
name: project-cross-repo-patch-hoist-contract
description: A starter's pnpm `patchedDependencies` only survives `lt fullstack init` with an lt CLI whose hoist moves it (introduced with 1.50.4); older CLIs drop it and break the first install. Includes how to prove the monorepo Docker build end to end.
metadata:
  type: project
---

**Fact (verified 2026-10-06):** pnpm reads `patchedDependencies` only from the WORKSPACE ROOT. In an
`lt fullstack` monorepo the CLI's `finalizeWorkspaceRoot()` → `hoistWorkspacePnpmConfig()` hoists
the sub-projects' pnpm settings to the root and **deletes a settings-only sub `pnpm-workspace.yaml`**.
The CLI working tree that became 1.50.4 added `patchedDependencies` to the hoisted `OBJECT_FIELDS`, and
`relocatePatches()` moves the patch file to `<root>/patches/`, because both starter Dockerfiles
(nuxt-base-template, nest-server-starter) copy only the CONTEXT-ROOT `patches/`. Older CLIs hoist the
override but drop `patchedDependencies` together with the deleted sub file. Proven: with that state,
the first `pnpm install` fails in projects/app postinstall with
`The requested module 'simple-git' does not provide an export named 'default'`.

**Why:** the nuxt-base-template pairs `overrides: simple-git: 4.0.2` (security fix, major jump) with
a patch that restores the ESM default export `@nuxt/devtools` imports. `lt fullstack init` clones the
starter's default branch unpinned. So users on an older CLI break as soon as that starter change
reaches GitHub. Release order matters: publish the CLI first.

**How to apply:** whenever a starter adds or changes `patchedDependencies`, check (1) that the CLI version
users actually run hoists it, and (2) that the patch reaches `<root>/patches/`. Do not settle for
"the hoist unit tests are green". Prove it end to end in the scratchpad:
- rsync lt-monorepo + `nuxt-base-template/` → `projects/app` + nest-server-starter → `projects/api`;
- in a scratch `npm ci` copy of the CLI, run `finalizeWorkspaceRoot({ filesystem, projectDir })`
  via `npx ts-node --transpile-only` (gluegun `filesystem`);
- `pnpm install` at the root, then `docker build -f projects/{app,api}/Dockerfile --build-arg
  {APP,API}_DIR=projects/{app,api} .` (use `--target deps` for the fast check).

Also: CI shell scripts with awk in them (claude-code `scan-secrets.sh`) were verified on
`ubuntu:24.04` under both mawk and gawk, in POSIX and C.UTF-8 locales. A macOS-only green run says
nothing about the runner.

Related: [[project-pnpm-audit-and-overrides]], [[project-infra-surface]].
