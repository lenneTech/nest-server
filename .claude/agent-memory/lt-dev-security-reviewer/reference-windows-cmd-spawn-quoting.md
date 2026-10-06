---
name: reference-windows-cmd-spawn-quoting
description: How to review a Windows .cmd-shim spawn (shell:true, one quoted string) from macOS — Node's exact cmd.exe argv, DEP0190, the CRT trailing-backslash class, cmd-shim quirks
metadata:
  type: reference
---

Verified 2026-10-06 while reviewing lt-monorepo `scripts/lib/spawn-plan.mjs` (no Critical/High found).

**Simulate Node's win32 shell path on macOS.** Preload `Object.defineProperty(process, 'platform', { value: 'win32' })`
and call `spawnSync(cmdString, [], { shell: true })`: the spawn fails with ENOENT, but `err.spawnargs` shows
the exact argv. Node 22 and 24 both build `['/d', '/s', '/c', '"<command>"']` with `windowsVerbatimArguments`.
`/s` strips only the outermost quote pair, so a quoted program path as the first token stays intact.
DEP0190 fires only when the args array is non-empty. Passing `[]` keeps it silent.

**Two parsers apply, and only one of them treats backslash as an escape.**
- cmd.exe: when tokens cannot contain `"`, every quote is a wrapper, so `& | < > ^ ( )` stay literal. `%` is
  expanded inside quotes (phase 1). `!` only matters with registry DelayedExpansion=1, which `/d` does NOT
  disable. Delayed expansion runs after operator parsing, so it can change a value but cannot inject a command.
- node.exe (CRT argv, reached through the shim's `%*`): a QUOTED token that ends in `\` turns `\"` into a
  literal quote and merges it with the next token. In 200k fuzzed plans this was the only mismatch class.
  The fix is to double the trailing backslashes before the closing quote.

**cmd-shim (npm/pnpm .cmd).** `@ECHO off` keeps stdout clean. The exit line uses the
`endLocal & goto #_undefined_# 2>NUL || ... & "%_prog%" ... %*` form. Exit codes still propagate, and
`npm run` on Windows relies on that. The shim's own `SET dp0=%~dp0` is UNQUOTED, so a shim installed in a
path containing `&` breaks itself. That is a pre-existing third-party issue and it fails loudly.

Related: [[reference-cross-repo-hoist-and-public-scanner]]
