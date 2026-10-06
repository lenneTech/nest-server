---
name: starter-config-env-two-bases
description: nest-server-starter config.env.ts has TWO disjoint bases (localConfig for local/e2e/ci, deployedConfig for develop/test/production); a commented example inside one only reaches that pipeline, so any "also holds in e2e/local" claim depends on placement
metadata:
  type: project
---

`nest-server-starter/src/config.env.ts` builds every environment from one of two helpers that share
NO base object: `localConfig()` → `local`, `e2e`, `ci`; `deployedConfig()` → `develop`, `test`,
`production`. Settings meant for every environment live in shared `PROJECT_*` constants (e.g.
`PROJECT_FILE`, `PROJECT_ERROR_CODE`) spread into both. A commented example placed inside
`deployedConfig()` and uncommented there never reaches the e2e suite or `lt dev up` (NODE_ENV=local).

**Why (2026-10-06, 11.42.4 starter follow-up):** the `bodyParser` example was added inside
`deployedConfig()` next to `trustProxy` (which IS deployment-specific), while its own text promised
"applied during module init, so it also holds in the e2e suite". Uncommented where it sits, e2e/local
stay at 100 kB — the prod/test divergence the feature was built to remove.

**How to apply:** for any new commented config example in the starter, ask whether the setting is
deployment-specific (`trustProxy`, `shutdownDelayMs`) or a property of the data model / app (body
limits, file roles). The latter belongs in a shared `PROJECT_*` constant or in both helpers. Check
any claim about e2e/local behaviour against the helper the example sits in. `NSC__*` vars in `.env`
apply to every environment (dotenv loads at the top), so the `.env.example` route has no such trap.
Related: [[config-env-is-consumer-owned]].
