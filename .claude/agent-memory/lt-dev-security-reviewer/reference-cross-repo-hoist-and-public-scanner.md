---
name: reference-cross-repo-hoist-and-public-scanner
description: Verified facts (2026-10-06) about lt CLI's patchedDependencies hoist (relocatePatches) and the public claude-code secrets scanner fed by claude-code-internal's denylist generator via --print
metadata:
  type: reference
---

Reviewed from this repo on 2026-10-06. Nothing reached the bar. These are the facts worth not re-deriving.

**lt CLI `relocatePatches` (`src/lib/hoist-workspace-pnpm-config.ts`)**
- The destination is sound: always `<root>/patches/<basename>`. A symlinked or non-dir root `patches/` is refused. It never overwrites (an own `exists` check plus fs-jetpack `moveSync`'s EEXIST). A dangling symlink at the destination is replaced by `rename`, never written through.
- On the source side only the FINAL path component is lstat'ed. A sub-project whose `patches/` DIRECTORY is a symlink gets followed. Probed:
  - pointing at the root `patches/`, the "identical" branch deletes the only copy, silently, with no conflicts reported;
  - pointing outside the project, the file is moved out of that directory.
- No template commits symlinks, and template content is already code-exec-trusted (`postinstall: nuxt prepare`), so this stayed below the bar. Re-check it if a flow ever creates sub-project symlinks. The fix is a `realpathSync` containment and same-inode check.
- Probe harness: ts-node needs `TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node10","ignoreDeprecations":"6.0"}'` plus `NODE_PATH=<cli>/node_modules` for a script that lives outside the repo.

**Public scanner (`claude-code/scripts/scan-secrets.sh`) and private generator (`claude-code-internal/scripts/build-public-denylist.ts --print`)**
- `--print` output is a SUPERSET of the file's patterns. Lines after `# <<< generated` are dropped by `--print`, but `--check` (private pre-commit) refuses such a file.
- Derived names are ERE-escaped (`escapeEre`). An invalid `DENY_RE` would silently disable check 7, because grep's errors go to `2>/dev/null`. Only hand-written lines can cause that.
- CI never has the denylist: there is no private checkout and no token. Check 7 reports only `file:line`, never the pattern, so nothing private reaches CI logs. Fork PRs run on `pull_request`, never `pull_request_target`.
- Pre-existing gap, not introduced by the change: `--range` uses the NET diff `A..B`, and checks 1-7 read the WORKTREE. A name added in one commit and removed in the next commit of the same push reaches public history unseen.
