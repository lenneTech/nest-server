---
name: config-env-is-consumer-owned
description: src/config.env.ts is copied into consumer projects at init and never re-synced — a "bugfix" landing there is NOT delivered by pnpm update, so any migration-guide claim of "it now just works" is wrong
metadata:
  type: project
---

`src/config.env.ts` in nest-server is the FRAMEWORK's own profile. Consumer projects own their own
copy (seeded from `nest-server-starter/src/config.env.ts` at `lt server create` / `lt fullstack
init` time) and never re-sync it. `pnpm update @lenne.tech/nest-server` therefore delivers **zero**
config.env.ts changes.

**Why:** In the 11.38.0 SMTP fix the framework changed `secure: process.env.SMTP_SECURE !== 'false'`
to `resolveSmtpSecure(...)` in its own `src/config.env.ts`, and the migration guide's §10 "Are you
affected?" table said *"You rely on the default on port 587 → **Mail starts working.**"* For an npm
consumer that is false: their config.env.ts still carries the broken line, and the only thing the
upgrade gives them is `EmailService`'s once-per-process warning. The starter was fixed in a
parallel, still-uncommitted session — which does not reach an existing project either.

**How to apply:** Whenever a diff touches `src/config.env.ts`, `src/main.ts`, or anything else a
consumer OWNS a copy of (config.env.ts, main.ts, server.module.ts, project user.service.ts, project
templates), the migration guide must carry an explicit **"change this in your own file"** step with
a before/after. Grade a guide that presents such a change as automatic as INACCURATE, not merely
incomplete. Cross-check the starter (`~/code/lenneTech/nest-server-starter`) — a fix present there
only proves NEW projects get it. See [[main-ts-optin-api-has-no-doc-surface]], which is the same
failure for main.ts.
