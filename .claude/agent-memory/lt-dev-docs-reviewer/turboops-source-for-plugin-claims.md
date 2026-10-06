---
name: turboops-source-for-plugin-claims
description: TurboOps source is checked out locally; use it (not the plugin text) to verify deploying-to-turboops claims about MCP tool names, params, behaviour and "TurboOps x.y+" version gates
metadata:
  type: reference
---

TurboOps source: `~/code/lenneTech/turbo` (private repository). MCP tools live under
`projects/api/src/server/modules/mcp/tools/{read,write}/*.tool.ts` (`name:` + zod `inputSchema` with
`.describe()` texts that state the contract). Traefik file generation + the custom-config safety rail:
`projects/api/src/server/modules/deployment/services/traefik-config.service.ts` → `deployStageTraefikConfig`.

**Dating a tool:** `package.json` version on `dev` is stale (read 1.69.0 while tags were at 1.74.1).
Use `git log --all -S"<tool_name>"` for the commit, then `git tag --contains <sha> --sort=v:refname`.
2026-10-06: `update_stage_domains` + `update_service_domain clear` (DEV-3424) first ship in v1.74.0;
the plugin's traps.md says "1.73.1+" — behaviour-neutral (hosted instance has them), not reported.

Nuance worth knowing: `reload_traefik_config` never deploys a hand-edited SAVED config — it writes the
generated one, or refuses with `hasCustomConfig: true` when a non-auto-generated saved config diverges.

Related: [[doc-surfaces-for-config-features]]
