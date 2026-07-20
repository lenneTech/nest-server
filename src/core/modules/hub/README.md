# Hub — Admin Area (Operator Cockpit)

A build-free, ADMIN-gated dashboard of runtime information and admin tools, served directly by the
framework. Inspired by the sister project [nest-base](https://github.com/lenneTech/nest-base)'s Hub,
but adapted to this stack (NestJS + GraphQL + Mongoose) and shipped as **dependency-free server-side
HTML + a vanilla-JS SPA** (no React, no build step) so it works identically in npm- and vendor-mode.

## Enable it

The Hub is **never enabled implicitly** — switch it on per environment:

```typescript
// config.env.ts
{
  hub: true,                          // enabled at /hub, admin-only, default collectors
  // or, with options:
  hub: {
    path: 'hub',                      // default 'hub'
    collectors: { queries: true },    // query profiler is opt-in (enables driver command monitoring)
    mailbox: { mode: 'capture' },     // built-in Mailpit-style mail capture (dev/test)
  },
}
```

Do NOT set `hub` in the `production` block unless you intend the cockpit to be reachable there
(it stays ADMIN-gated). See `IHubConfig` in `interfaces/hub-config.interface.ts` for every option.

## Panels

| Panel                | Route                 | Source                                                          |
| -------------------- | --------------------- | --------------------------------------------------------------- |
| Dashboard            | `/hub`                | health, build info, memory, feature matrix, links               |
| Diagnostics          | `/hub/diagnostics`    | heap/rss, node/platform, collector buffer levels                |
| Logs                 | `/hub/logs`           | in-memory log ring buffer (redacted)                            |
| Request Traces       | `/hub/traces`         | HTTP timing middleware                                          |
| Query Performance    | `/hub/queries`        | MongoDB driver command monitoring (opt-in)                      |
| Cron Jobs            | `/hub/cron`           | `@nestjs/schedule` `SchedulerRegistry` (optional)               |
| Database             | `/hub/db`             | dbStats / per-collection collStats                              |
| Models / ERD         | `/hub/models`         | Mongoose schemas → Mermaid ER diagram                           |
| Migrations           | `/hub/migrations`     | `MigrationRunner` status + run/rollback                         |
| Files                | `/hub/files`          | GridFS listing + delete                                         |
| Config               | `/hub/config`         | full config, secrets masked                                     |
| Auth Migration       | `/hub/auth-migration` | Legacy → IAM progress (BetterAuth, optional)                    |
| Routes / Permissions | `/hub/routes`         | route + role + `@Restricted` map (Permissions module, optional) |
| Error Codes          | `/hub/error-codes`    | de/en catalog (ErrorCode module, optional)                      |
| Email Preview        | `/hub/emails`         | EJS templates rendered with sample data                         |
| Mailbox              | `/hub/mailbox`        | captured outgoing mail (Mailpit replacement)                    |
| AI                   | `/hub/ai`             | AI usage summary (AI module, optional)                          |

Each panel has a `*.json` sidecar (the stable data contract) that the client polls. Optional sources
degrade to an "unavailable" state instead of erroring.

## Actions (mutating)

Enabled by default (`actions: true`). Every mutating request requires the `X-Hub-Request: 1` header
(CSRF defense) and destructive ones a server-validated `confirm` keyword:

| Action                  | Endpoint                                   | Confirm      |
| ----------------------- | ------------------------------------------ | ------------ |
| Run pending migrations  | `POST /hub/actions/migrations/run`         | `RUN`        |
| Rollback last migration | `POST /hub/actions/migrations/down`        | `DOWN`       |
| Delete GridFS file      | `DELETE /hub/actions/files/:id`            | the filename |
| Cron start/stop/trigger | `POST /hub/actions/cron/:name/:action`     | the job name |
| Clear collector buffer  | `POST /hub/actions/collectors/:name/clear` | `CLEAR`      |
| Send test mail          | `POST /hub/actions/email/test`             | —            |

Every action writes an audit line: `[HUB-ACTION] <action> by user <id>`.

## Security

- **Auth**: the DATA sidecars (`*.json`) and all actions are `@Roles(RoleEnum.ADMIN)` (configurable
  via `hub.roles`; `false` = public — dangerous). The **shell** (page routes) is public chrome only —
  it shows a **login form** when the data is 401, so the Hub is self-sufficient: an admin can sign in
  directly at the API (email/password → `loginEndpoint`, default `/iam/sign-in/email` → session cookie)
  without the frontend, with a token-paste fallback for cookie-less setups. In fullstack, a
  cross-subdomain session cookie from the app login already authenticates `/hub` — no separate login.
  A **"Sign out"** button in the topbar POSTs to `hub.logoutEndpoint` (default `/iam/sign-out`),
  clears the session cookie + any pasted token, and returns to the login gate. The logout endpoint is
  delivered only in the ADMIN-gated `session.json` payload, never in the public shell.
  - **Public-shell trade-off (by design):** because the shell must render before authentication, its
    HTML source reveals the panel structure, the environment name (shown on the login card) and any
    configured external links (`hub.links.*`) to an unauthenticated request. This is intentional — the
    panel structure is already discoverable via the public `hub.js` — and carries no data: every
    `*.json` sidecar and every action stays ADMIN-gated. Do not place secrets in `hub.links.*` (e.g.
    an internal Mailpit URL) if the shell's origin is reachable by untrusted clients.
- **Action errors**: mutating actions return plain admin-facing messages (not `ErrorCode` catalog
  entries) by design — the `ErrorCode` i18n module is optional and the Hub cannot hard-depend on it.
  The messages are centralized in `hub-action-messages.ts` (`HubActionMessage`) so the wording stays
  consistent and reviewable in one place.
- **CSP**: strict per-request nonce; no `unsafe-inline`; `X-Frame-Options: DENY`; `no-store`.
- **Secrets**: the config viewer deep-clones and masks by key pattern + `security.secretFields`.
- **Interceptor safety**: sidecars return pre-serialized JSON strings, so the global response
  interceptors never walk/mutate live config.
- **Mailbox guard**: `mode: 'capture'` throws at startup in any **reachable** environment (anything
  whose `env` is not `local`/`development`/`test`/`ci`/`e2e`) — it suppresses outgoing mail.
- **Public-access guard**: `roles: false` (no auth check — public config viewer, logs and destructive
  actions) throws at startup in any **reachable** environment unless `hub.allowPublicAccessInProduction:
true` is set explicitly. This closes the single most dangerous Hub misconfiguration (a `roles: false`
  copied from a local config into a reachable environment). The reachable check is fail-safe: it treats
  every env name except the known local/test set as reachable, so a custom name (`prod`, `preprod`,
  `staging-2`, …) cannot bypass it. Only acknowledge public access behind a fully-controlled network
  boundary (VPN / IP allow-list / authenticating reverse proxy).
- **No-guard warning**: the Hub registers no guard of its own — its ADMIN gate is enforced by the
  app-wide roles guard from BetterAuth (IAM) or the legacy Auth module. If the Hub is enabled and
  gated but neither is active (and you have not registered your own `APP_GUARD`), `CoreModule` logs a
  loud startup warning, because nothing would then enforce the gate.
- **CSRF**: mutating actions require the `X-Hub-Request` custom header, which forces a CORS preflight
  that a restrictive allowlist rejects for foreign origins — **that header** (not the type-to-confirm
  keyword, which is public UX safety, not a token) is the CSRF barrier. It holds with the default
  `SameSite=Lax` session cookie or Bearer-token auth. Do NOT combine `cors.allowAll: true` with a
  `SameSite=None` cookie (cross-subdomain fullstack): that lets any origin pass the preflight — pin
  `cors` to your `appUrl` instead.
- **Redaction is best-effort (ADMIN-only surfaces)**: the config viewer masks by key pattern +
  `security.secretFields` (a secret under an unusual key can slip); the logs/queries collectors and
  the copy-mode mailbox redact patterned secrets (JWT / Bearer / `key=value` / cookie / reset-link
  path tokens) but cannot catch an arbitrary value logged without a recognizable shape. All are
  ADMIN-gated — treat Hub access as equivalent to config/log read access.

### Routes / Permissions panel vs. the standalone `/permissions` endpoint

The **Routes / Permissions** panel renders the same data as the standalone permissions module — the
full security map (every route + its required roles + `@Restricted` field rules) — but _inside_ the
Hub, so it inherits the Hub's ADMIN gate, per-environment opt-in and strict CSP. It reuses the
permissions **scanner** (`CorePermissionsService`), so it needs the `permissions` module enabled
(`config.permissions`); otherwise the panel degrades to an "unavailable" state.

The two surfaces are **independent** and answer the common "how do I reach it?" questions:

| Situation                                       | How to reach the report                                                                                                                                                                                                                                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hub **on**, `permissions` **on**                | Hub → **Routes / Permissions** panel (ADMIN, login-gated by the Hub). The standalone `/permissions` also works per its own `role` (default ADMIN).                                                                                                                         |
| Hub **off**, `permissions` **on** (ADMIN)       | The standalone `/permissions` is ADMIN-gated but has **no login page** — reach it with an ADMIN **session cookie** (be logged in via the app) or a **bearer token** (`Authorization: Bearer <jwt>` from `POST /iam/sign-in/email`), exactly like any other ADMIN endpoint. |
| Hub **off**, want frictionless **local** access | Set `permissions: { role: false }` — public, no auth. Legitimate **only** on a local, non-network-reachable machine, as a conscious opt-in. Never ship it to a reachable environment: the report is a reconnaissance goldmine.                                             |
| `permissions` **off**                           | No report anywhere: `/permissions` is not registered (404) and the Hub panel shows "unavailable".                                                                                                                                                                          |

**Security note:** the permissions report exposes your entire authorization model. Keep it ADMIN
(the default) everywhere it could be reachable; use `role: false` only behind a network boundary you
fully control. In production the framework's own config does not register the permissions module at all.

## Collectors

Three in-memory ring buffers (fixed capacity, no timers, per-app-instance — parallel-test-safe):

- **Logs** — installs a chaining `Logger.overrideLogger()` delegate (no main.ts change), restored on shutdown.
- **Traces** — an Express middleware registered only when enabled (zero cost otherwise).
- **Queries** — MongoDB driver command monitoring; records value-free query SHAPES (N+1 templates), never values.
  Enabling it opts the driver into `monitorCommands` from `core.module.ts`.

## Overrides

```typescript
CoreModule.forRoot(envConfig, {
  hub: { service: MyHubService, htmlService: MyHubHtmlService },
});
```

Fields: `controller`, `actionsController`, `service`, `htmlService`, `actionsService`.

See [INTEGRATION-CHECKLIST.md](./INTEGRATION-CHECKLIST.md) for setup in a consumer project.