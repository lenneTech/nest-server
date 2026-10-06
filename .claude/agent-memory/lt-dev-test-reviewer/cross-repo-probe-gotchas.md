---
name: cross-repo-probe-gotchas
description: Probing shell tests and internal-data scripts during a cross-repo review: zsh MULTIOS leaks stdout into a stderr-only pipe, and node:24 docker reproduces the GitHub CI mawk for scanner tests
metadata:
  type: reference
---

Two things learned in the 2026-10-06 cross-repo review (cli hoist, claude-code scan-secrets,
claude-code-internal denylist generator).

**The Bash tool runs zsh, and zsh MULTIOS breaks the stderr-only idiom.**
`cmd 2>&1 >/dev/null | head` sends stdout into the pipe AS WELL in zsh (in bash it would be
dropped). Probing `bun scripts/build-public-denylist.ts --print` this way pushed redacted
fragments of real customer patterns into the transcript. When a script's stdout is internal
data, write each stream to its own temp file (`2>err >out`) and print only counts or
`grep -c` comparisons, never the content.

**Reproduce the GitHub CI awk locally.** Ubuntu runners use mawk, macOS ships BSD awk 20200816.
The `node:24` image (Debian bookworm) is cached here and has mawk 1.3.4 + git + `file`;
`ubuntu:24.04` has no git. Pattern: mount the copy read-only, `cp -r /w /tmp/w`, run with and
without `LANG=C.UTF-8`. Homebrew `gawk` via a PATH shim covers the third dialect.

**Hook stdin:** a pre-push hook that runs the scanner and THEN reads the ref list from stdin
only works if the scanner consumes no stdin. Verify with
`printf 'refs…\n' | (bash scan.sh --all >/dev/null; cat)` — the ref line must survive.

**zsh does not word-split `$VAR`.** `SPECS="a.spec.ts b.spec.ts"; vitest run $SPECS` passes ONE
argument, vitest finds no file and exits 1 — which an ad-hoc mutation runner reads as "went red".
Use arrays or literal paths, and require a failing TEST NAME in the output, never just exit != 0
(the same rule `check:mutations` enforces with a parsed failure count).

Related: [[scratch-copy-mutation-check]].
