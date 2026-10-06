---
name: internal-project-names-in-templates
description: offers and lt-crm are lenne.Tech INTERNAL projects, not customers — naming them in template-shipped files is not a customer-name leak
metadata:
  type: reference
---

`offers` and `lt-crm` are lenne.Tech's own internal
projects. Both are routinely cited as measurement sources in files that ship into every generated
project (nest-server-starter `scripts/check-overrides.mjs`, `SECURITY.md`, the guard spec;
nuxt-base-template `CLAUDE.md`, `pnpm-workspace.yaml`). TurboOps is lenne.Tech's own product too.

**Why:** the "no customer project names in template files" rule (migration-guides.md, wave reviews)
invites flagging every project name; these three are not customer data. Verified 2026-10-06 via the
repositories' git remotes.

**How to apply:** don't flag offers / lt-crm / TurboOps in nuxt-base-template/** or
nest-server-starter/**. A name NOT on this list (e.g. b7capture) still needs checking — check its git
remote: lenne.Tech's internal group = internal, anything else = treat as customer. Related:
[[override-recipe-vs-consumer-lockfiles]].
