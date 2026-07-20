# Hub Integration Checklist

The Hub is **config-only** — no files need to be created in the consuming project. It is auto-registered
by `CoreModule.forRoot()` when `hub` is present in the config.

## Reference Implementation

- Local: `node_modules/@lenne.tech/nest-server/src/core/modules/hub/`
- The framework's own e2e config (`src/config.env.ts`) enables it in `local`/`development`/`e2e`/`ci`.

## Quick Setup

### 1. Enable per environment

**Edit:** `src/config.env.ts`

```typescript
// development / local
hub: {
  collectors: { queries: true },   // opt-in query profiler
  mailbox: { mode: 'capture' },    // capture outgoing mail locally (Mailpit replacement)
},

// production — usually omit `hub` entirely, or (if you want it, still ADMIN-gated):
// hub: { collectors: { queries: false }, mailbox: false },
```

That's it. Sign in as a user with `RoleEnum.ADMIN` and open `/hub`.

## Optional Enhancements

| Want                        | Do                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Cron panel populated**    | Import `ScheduleModule.forRoot()` in your ServerModule (usually already present).                                                                                              |
| **Query profiler**          | Set `hub.collectors.queries: true` (opts the driver into `monitorCommands`).                                                                                                   |
| **Migrations run/rollback** | Set `hub.migrations.dir` to your migrations directory (default `./migrations`). In compiled deployments point it at the built JS. Use `lockCollectionName` for cluster safety. |
| **Custom look / behavior**  | Pass `overrides.hub.{controller,actionsController,service,htmlService,actionsService}` to `CoreModule.forRoot()`.                                                              |

## Verification Checklist

- [ ] `pnpm run build` succeeds
- [ ] Sign in as ADMIN → `GET /hub` returns the dashboard HTML
- [ ] A non-admin user gets `403`; an anonymous request gets `401`
- [ ] `GET /hub/dashboard.json` returns build/memory/features
- [ ] `GET /hub/config.json` shows `***` for secrets (never the real values)
- [ ] Mutating actions without `X-Hub-Request: 1` return `403`

## Common Mistakes

| Mistake                                          | Symptom                                                        | Fix                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hub` not set in the target environment          | `/hub` → 404                                                   | Add `hub: true` (or an options object) to that env's config block                                                                                                                                                                                                                                  |
| `mailbox.mode: 'capture'` in production          | Startup error                                                  | Use `mode: 'copy'` or disable the mailbox in production — capture suppresses all mail                                                                                                                                                                                                              |
| Query panel empty                                | queries collector off (default)                                | `hub.collectors.queries: true`                                                                                                                                                                                                                                                                     |
| Cron panel empty                                 | `ScheduleModule.forRoot()` not imported                        | Import it in your ServerModule                                                                                                                                                                                                                                                                     |
| Hub path collides with a project route           | 404 / wrong page                                               | Set a distinct `hub.path` (e.g. `admin/hub`)                                                                                                                                                                                                                                                       |
| No roles guard registered (auth system disabled) | Every `/hub` sidecar/action returns 200 for anonymous requests | The Hub relies on the framework's `RolesGuard`/`BetterAuthRolesGuard` (registered by the auth/BetterAuth module) to enforce `@Roles(RoleEnum.ADMIN)`. If you disable BetterAuth AND legacy auth, no guard runs and the ADMIN gate is inert. Keep an auth module enabled, or do not expose the Hub. |

> **Auth dependency (why):** the Hub does not register its own guard — it assigns `@Roles(hub.roles)`
> (default `ADMIN`) as metadata and depends on the app-wide `RolesGuard` / `BetterAuthRolesGuard` to
> read it. That guard ships with the auth/BetterAuth modules. In a normal project one of them is
> active, so the gate works out of the box; but an app that runs with _no_ auth system has no guard
> to enforce the roles, and the sidecars/actions would be reachable unauthenticated. Either keep an
> auth module enabled or leave the Hub disabled in such a setup.