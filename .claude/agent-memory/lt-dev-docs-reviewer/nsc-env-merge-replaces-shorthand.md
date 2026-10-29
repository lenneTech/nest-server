---
name: nsc-env-merge-replaces-shorthand
description: An NSC__A__B env var over a config key whose value is a string/boolean shorthand REPLACES the whole value with { b } (lodash merge) — check any doc that pairs a shorthand form with an NSC__ sub-key
metadata:
  type: reference
---

`getEnvironmentConfig()` merges `getEnvironmentObject()` (NSC__ vars → nested object, `A__OWNER_URL` → `a.ownerUrl`)
into the config with lodash `mergeWith`. When the existing value is NOT an object (string shorthand
`database: 'postgres://…'`, boolean shorthand `cookies: false`, `jwt: true`), lodash replaces it with a fresh object
holding only the env sub-key. Verified 2026-10-28: `{ database: 'postgres://app@db/app' }` +
`NSC__DATABASE__OWNER_URL` → `{ database: { ownerUrl } }`, the URL gone, no warning.

**How to apply:** whenever a doc names an `NSC__X__Y` variable for a key that also has a string/boolean shorthand,
ask what happens to a project using the shorthand. For "presence implies enabled" keys the clobber can also FLIP a
feature on (`false` → `{ y }`). Probe recipe: a `zz-*.ts` at the repo root importing `getEnvironmentObject` / `merge`
from `src/core/common/helpers/config.helper.ts` with a custom `processEnv`, run with `npx tsx`, delete after.
Related: [[db-agnostic-phase0-doc-facts]], [[executable-doc-recipes]].
