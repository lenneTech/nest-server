---
name: npm files array includes .claude/rules and CLAUDE.md
description: Since 11.22.0, .claude/rules/**/* and CLAUDE.md are explicitly included in the npm package files array for AI-assisted development in consuming projects
type: project
---

Since v11.22.0 the `files` array in `package.json` includes:
- `CLAUDE.md`
- `.claude/rules/**/*`
- `docs/**/*`
- `migration-guides/**/*`

**Why:** Intentional — consuming projects (nest-server-starter users) benefit from the AI rules and docs when developing with Claude Code.

**How to apply:** When reviewing npm publish changes, verify that `.claude/agent-memory/**` and `.claude/commands/**` are NOT matched by the glob (they are not — only `.claude/rules/` is included). No hardcoded secrets exist in the included files. The testing.md reference to `mongodb://127.0.0.1/nest-server-local` is a localhost dev URL, not a credential.
