---
name: starter-update-does-not-apply-every-row
description: A guide's "pnpm run update applies the table" is false per row — RAISE_SOURCES never lifts a runtime pin from a framework devDep, and it never adds a package; check every dependency row against package.json AND that rule
metadata:
  type: project
---

nest-server-starter's `pnpm run update` (`extras/sync-packages.mjs` → `align-package-versions.mjs`,
`RAISE_SOURCES = { dependencies: ['dependencies'], devDependencies: ['dependencies', 'devDependencies'] }`)
raises a consumer pin only from the framework section that may drive it, never lowers, and never adds
(`--add-missing` aside), then runs `pnpm install` (not `pnpm update`). So a guide sentence like "update
applies the table" silently skips: the better-auth trio (framework devDeps → consumer deps: never raised),
and any package the project does not declare yet (e.g. a `vite` pin the guide asks for).

Separately, the table VALUES drift: 12.0.0's guide listed mongoose 9.11.3 while package.json had 9.11.4.
A hand-applied lower pin gives pnpm two `@nestjs/mongoose` instances (peer-suffixed by mongoose version),
proven with a lockfile-only scratch install — the starter's models use their own `SchemaFactory` against
`@Prop` metadata registered through nest-server's copy.

**Why:** reported High on 2026-10-24 (mongoose row, corrected to 9.11.4 the same day); better-auth/vite gaps stayed below the bar because
`pnpm peers check` / §12 surface them.
**How to apply:** diff every row of a guide's dependency table against `git diff HEAD -- package.json`,
then classify each row by RAISE_SOURCES. Recipe in [[executable-doc-recipes]].
Related: [[consumer-mongodb-pin-is-runtime]], [[override-recipe-vs-consumer-lockfiles]].
