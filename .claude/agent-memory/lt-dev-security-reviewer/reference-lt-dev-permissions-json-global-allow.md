---
name: reference-lt-dev-permissions-json-global-allow
description: How lt-dev's permissions.json reaches users (silent global auto-allow via `lt claude plugins`), and why a new broad pattern there rarely widens the effective boundary (node:* / curl:* already present)
metadata:
  type: reference
---

Verified 2026-10-06 while reviewing `/lt-dev:briefing` (claude-code working tree).

**Consumer:** `cli/src/commands/claude/plugins.ts` → `setupPermissions()` in `cli/src/lib/plugin-utils.ts`.
Every `pattern` in `plugins/lt-dev/permissions.json` is appended to `~/.claude/settings.json`
`permissions.allow`. That rule is GLOBAL: it applies in every session and every project, not only
in the command listed in `usedBy`. It is append-only and silent (the spinner prints only "(N added)").

**Why a new broad entry is usually least-privilege debt, not a new capability:** the global
list already holds `Bash(node:*)` (arbitrary code via `node -e`), `Bash(curl:*)`, `Bash(gh api:*)`,
`Bash(git fetch:*)`, `Bash(git push:*)`, `Bash(gh pr:*)`, `Bash(glab mr:*)`, `Bash(glab ci:*)`.
So `Bash(glab api:*)` (added for briefing; permits `--method DELETE`, CI-variable reads) stayed
below the bar. Re-assess if `node:*` / `curl:*` are ever removed — then a broad API pattern
WOULD become the widening.

**`git ls-remote` is not read-only:** `git ls-remote --upload-pack="<cmd>" .` executes `<cmd>`
locally (probed in a scratch repo). Same for `git fetch --upload-pack`. Matters only if the list
ever stops containing an arbitrary-exec primitive.

**Command-scoped `allowed-tools`** in `ship.md` / `ticket-cycle.md` already grant `Bash(gh:*)` and
`Bash(glab:*)`; a new command with narrower gh/glab prefixes is parity, not a widening.

Related: [[reference-cross-repo-hoist-and-public-scanner]]
