# System Setup Module

Initial admin user creation for fresh deployments of @lenne.tech/nest-server.

## TL;DR

System setup is **enabled by default** when BetterAuth is active. No configuration needed locally.

**In a deployed environment** (anything but `local`, `ci` and `e2e`) the anonymous `POST /system-setup/init` is
**closed** since 12.4.0. Provision the first admin via ENV instead — it is created on the next start:

```bash
NSC__SYSTEM_SETUP__INITIAL_ADMIN__EMAIL=admin@example.com
NSC__SYSTEM_SETUP__INITIAL_ADMIN__PASSWORD=YourSecurePassword123!
```

Or open the HTTP init on purpose, preferably with a setup token (see [HTTP init](#http-init-systemsetuphttpinit)):

```bash
NSC__SYSTEM_SETUP__HTTP_INIT__TOKEN=<secret of at least 16 characters>   # sent as X-System-Setup-Token
```

**Quick Links:** [Integration Checklist](./INTEGRATION-CHECKLIST.md) | [Endpoints](#endpoints) | [Configuration](#configuration) | [Security](#security)

---

## Table of Contents

- [Purpose](#purpose)
- [Endpoints](#endpoints)
- [Configuration](#configuration)
- [HTTP init (`systemSetup.httpInit`)](#http-init-systemsetuphttpinit)
- [Auto-Creation via Config/ENV](#auto-creation-via-configenv)
- [Security](#security)
- [Frontend Integration](#frontend-integration)
- [Troubleshooting](#troubleshooting)

---

## Purpose

When a system is freshly deployed (zero users in the database), there is no way to create an initial admin user - especially when BetterAuth's `disableSignUp` is enabled. This module provides:

1. **REST endpoints** - Manual admin creation via API call — open by default only in `local`, `ci` and `e2e`
2. **Auto-creation** - Automatic admin creation on server start via config/ENV — the way for a deployment

Once any user exists, the init endpoint is permanently locked (returns 403) and auto-creation is skipped.

---

## Endpoints

| Method | Endpoint               | Description                 |
| ------ | ---------------------- | --------------------------- |
| GET    | `/system-setup/status` | Check if system needs setup |
| POST   | `/system-setup/init`   | Create initial admin user   |

### GET /system-setup/status

Returns the current setup status.

**Response:**

```json
{
  "needsSetup": true,
  "betterAuthEnabled": true,
  "httpInitEnabled": true,
  "httpInitTokenRequired": false
}
```

| Field                   | Meaning                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `needsSetup`            | No user exists yet                                                                                      |
| `betterAuthEnabled`     | BetterAuth is active (required for the init)                                                            |
| `httpInitEnabled`       | `POST /system-setup/init` is open in this environment (12.4.0+). Independent of `needsSetup`            |
| `httpInitTokenRequired` | The init needs the `X-System-Setup-Token` header (12.4.0+). Only `true` together with `httpInitEnabled` |

A frontend offers the setup form only when `needsSetup && httpInitEnabled`, with a token field when
`httpInitTokenRequired`. A backend older than 12.4.0 sends neither field; its init is open as before.

### POST /system-setup/init

Creates the initial admin user. Only works when zero users exist, and only where `systemSetup.httpInit` opens it
(by default in `local`, `ci` and `e2e`).

**Request Header** (only when a token is configured): `X-System-Setup-Token: <setup token>`

**Request Body:**

```json
{
  "email": "admin@example.com",
  "password": "SecurePassword123!",
  "name": "Admin"
}
```

| Field      | Type   | Required | Validation               |
| ---------- | ------ | -------- | ------------------------ |
| `email`    | string | Yes      | Valid email format       |
| `password` | string | Yes      | Minimum 8 characters     |
| `name`     | string | No       | Defaults to email prefix |

**Success Response (201):**

```json
{
  "success": true,
  "email": "admin@example.com",
  "message": "Initial admin user created successfully"
}
```

**Error Response (403):**

```json
{
  "message": "LTNS_0050: System setup not available - users already exist, or the initial-admin setup is claimed"
}
```

The refusals are checked in this order: `LTNS_0053` (HTTP init not enabled here), `LTNS_0054` (setup token missing
or wrong), then `LTNS_0050` and `LTNS_0052` as before. See [Error Codes](#error-codes).

---

## Configuration

System setup is **enabled by default** when BetterAuth is active:

| Config                                   | Effect                                                                |
| ---------------------------------------- | --------------------------------------------------------------------- |
| _(not set)_                              | Enabled (when BetterAuth is active); HTTP init open only locally      |
| `systemSetup: { enabled: false }`        | Disabled explicitly (no endpoints)                                    |
| `systemSetup: { initialAdmin: { ... } }` | Enabled with auto-creation                                            |
| `systemSetup: { httpInit: ... }`         | Opens or closes `POST /system-setup/init` explicitly (12.4.0+, below) |

```typescript
// config.env.ts

// Enabled by default - no config needed

// Disable explicitly
systemSetup: { enabled: false },

// Enable with auto-creation (for automated deployments)
systemSetup: {
  initialAdmin: {
    email: process.env.INITIAL_ADMIN_EMAIL,
    password: process.env.INITIAL_ADMIN_PASSWORD,
  },
},
```

---

## HTTP init (`systemSetup.httpInit`)

`POST /system-setup/init` is anonymous: on an API without users, whoever calls it becomes the administrator. Since
12.4.0 it is therefore **fail-closed** outside the local environments.

| `httpInit`                              | `local` / `ci` / `e2e` | every other environment (`develop`, `test`, `production`, …) |
| --------------------------------------- | ---------------------- | ------------------------------------------------------------ |
| _(not set)_                             | open                   | **closed** — 403 `LTNS_0053`                                 |
| `true`                                  | open                   | open, without a token                                        |
| `{ token: '<at least 16 characters>' }` | open, token required   | open, token required — 403 `LTNS_0054` without it            |
| `false` / `{ enabled: false, token }`   | closed                 | closed                                                       |

The environment is the configured `env` (else `NODE_ENV`), compared with the framework's one list of local
environments (`isLocalEnv()`). The deployed `develop` and `test` stages of a starter-based project, `production`,
`staging` and any unknown or missing name count as deployed.

```typescript
// config.env.ts — open with a token (recommended when the setup must happen over the UI)
systemSetup: {
  httpInit: { token: process.env.SETUP_TOKEN },
},
```

```bash
# the same via ENV — set ONE of the two
NSC__SYSTEM_SETUP__HTTP_INIT__TOKEN=<secret of at least 16 characters>
NSC__SYSTEM_SETUP__HTTP_INIT=true   # open WITHOUT a token: whoever is first becomes admin
```

**The token** travels in the `X-System-Setup-Token` header, never in the body, and is compared in constant time.
Hand it to the person who sets the system up, the same way as a password.

**Misconfigurations close, they never open:**

- an object whose token is missing, empty, shorter than 16 characters or not a string keeps the init closed and logs
  an error at boot. `{ token: process.env.SETUP_TOKEN }` with the variable unset must not become an open init.
- an empty or all-digit `NSC__SYSTEM_SETUP__HTTP_INIT__TOKEN` is converted to a number by the environment reader, and
  a long digit string loses digits on the way — such a value is refused. Use a token with letters.
- a value that is neither a boolean nor an object (the string `"true"` from `NEST_SERVER_CONFIG`) counts as not set.

**Boot report.** A deployed instance that starts with zero users, no usable `initialAdmin` and a closed HTTP init logs
an error naming both ways in. With the init open without a token it logs a warning. Local environments stay silent.

The Swagger document leaves `POST /system-setup/init` out while the init is closed, like every operation that would
refuse every caller.

---

## Auto-Creation via Config/ENV

For automated deployments where no manual REST call is possible (Docker, CI/CD, Kubernetes), configure initial admin credentials via environment variables:

### Via NSC Environment Variables

```bash
NSC__SYSTEM_SETUP__INITIAL_ADMIN__EMAIL=admin@example.com
NSC__SYSTEM_SETUP__INITIAL_ADMIN__PASSWORD=YourSecurePassword123!
NSC__SYSTEM_SETUP__INITIAL_ADMIN__NAME=Admin  # optional
```

Every segment in SCREAMING_SNAKE_CASE. The environment reader lowercases a segment it does not split at `_`, so the
camelCase form `NSC__systemSetup__initialAdmin__email` — which this README showed until 12.4.0 — lands under
`systemsetup.initialadmin` and is never read. Since 12.4.0 the boot warns about such a variable and names the correct
spelling.

### Via config.env.ts

```typescript
systemSetup: {
  initialAdmin: {
    email: process.env.INITIAL_ADMIN_EMAIL,
    password: process.env.INITIAL_ADMIN_PASSWORD,
    name: 'Admin',
  },
},
```

### Via NEST_SERVER_CONFIG JSON

```bash
NEST_SERVER_CONFIG='{ "systemSetup": { "initialAdmin": { "email": "admin@example.com", "password": "SecurePassword123!" } } }'
```

### Behavior

- The admin is created automatically during application bootstrap (`OnApplicationBootstrap`)
- Not affected by `systemSetup.httpInit`: the configured admin is created in every environment
- Same zero-user guard applies: only works when no users exist
- If users already exist, auto-creation is silently skipped (no error)
- Race conditions between multiple instances are handled gracefully: the zero-user check alone is
  check-then-act, so N replicas booting at the same time would each pass it. Before creating, an
  instance claims the setup by upserting the marker `{ _id: 'initial-admin' }` into the
  `system-setup-locks` collection — an atomic operation only one instance wins. The others log a
  debug message and skip. If creation fails, the marker is removed again so a later boot can retry.
  After a SUCCESSFUL setup the marker REMAINS — setup must never run twice in a deployment. Test
  suites that reset the database to replay the setup flow therefore have to drop `system-setup-locks`
  alongside `users`; clearing only `users` leaves setup refused until the claim goes stale (5 min).
- **On a PostgreSQL default source** (`database`) the claim is the row `system-setup:initial-admin` in
  the lease table `lt_locks`, with the same semantics: one replica wins, released on failure, kept
  after success, taken over once stale. Where this README names `system-setup-locks`, read that row.

### Security Best Practices

1. **Remove credentials after first deployment** - Once the admin exists, the ENV vars are unused
2. **Use secrets management** - Docker Secrets, Kubernetes Secrets, Vault, etc.
3. **Never commit credentials** - Use `.env` files (gitignored) or external secret stores
4. **Use strong passwords** - Minimum 8 characters, recommended 16+

---

## Security

1. **Fail-closed HTTP init (12.4.0)** - Outside `local`, `ci` and `e2e` the anonymous init answers 403
   `LTNS_0053` unless `systemSetup.httpInit` opens it, preferably with a setup token. Before 12.4.0 a
   deployment without `initialAdmin` could be taken over by whoever called the init first
2. **Zero-user guard** - Init requires `countDocuments({}) === 0`. Necessary but not sufficient:
   the atomic claim below must also be winnable, so an empty `users` collection alone does not
   re-open setup
3. **Rollback on failure (12.4.0)** - When a step after creating the user fails (account, sync, role),
   the user is removed again, so `needsSetup` stays `true` and the setup can be retried. Before,
   the deployment kept a user without the admin role and was locked for good
4. **A killed setup is finished at the next boot** - A process killed halfway (SIGKILL, OOM) runs no rollback.
   The admin role is therefore written together with the user, so the worst a kill leaves is an administrator
   without a login account. With `initialAdmin` configured, the next boot finishes the setup for that address: it
   adds the credential account with the configured password and sets the role. It also finishes the leftover of an
   older setup (no role, no administrator in the system, and no account or only a credential account with the
   configured password). A user with another password, a social account or a second account is never touched. A
   restart within five minutes of the kill finds the old claim still held and tries once more after it goes stale.
   The anonymous HTTP init finishes nothing: once users exist it refuses, as before
5. **Race condition protection** - MongoDB unique email index prevents duplicates; auto-creation on
   bootstrap is additionally claimed atomically via the `system-setup-locks` marker
6. **Permanent lock** - Once any user exists, init returns 403
7. **BetterAuth required** - Returns 403 if BetterAuth is not enabled

### How It Bypasses disableSignUp

The service uses BetterAuth's `$context.internalAdapter.createUser()` directly, which is the same approach used by Better-Auth's own admin plugin. This bypasses the `disableSignUp` flag while still creating proper BetterAuth accounts.

---

## Frontend Integration

Typical frontend flow:

```typescript
// 1. Check if setup is needed AND possible over HTTP
const status = await fetch('/system-setup/status');
const { needsSetup, httpInitEnabled = true, httpInitTokenRequired = false } = await status.json();
// (the defaults keep a backend older than 12.4.0 working, where both fields are missing)

if (needsSetup && httpInitEnabled) {
  // 2. Show setup form (with a token field when httpInitTokenRequired) and submit
  const result = await fetch('/system-setup/init', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(httpInitTokenRequired ? { 'X-System-Setup-Token': setupToken } : {}),
    },
    body: JSON.stringify({
      email: 'admin@example.com',
      password: 'SecurePassword123!',
      name: 'Admin',
    }),
  });

  // 3. Sign in with the created admin
  // Use BetterAuth sign-in endpoint
}
```

---

## Troubleshooting

### Init returns 403 `LTNS_0053` "not enabled in this environment"

**Cause:** the environment is not `local`, `ci` or `e2e`, and `systemSetup.httpInit` does not open the init — the
default since 12.4.0.

**Solutions:**

1. Set `NSC__SYSTEM_SETUP__INITIAL_ADMIN__EMAIL` / `__PASSWORD` and restart — the admin is created at boot
2. Or open the init with a token: `NSC__SYSTEM_SETUP__HTTP_INIT__TOKEN=<secret>` (sent as `X-System-Setup-Token`)
3. Check the boot log: an unusable token configuration is logged as an error naming what is wrong

### Init returns 403 `LTNS_0054` "setup token is missing or invalid"

**Cause:** the init requires a token and the request sent none or a different one. Send the configured value in the
`X-System-Setup-Token` header. A frontend learns that a token is needed from `httpInitTokenRequired`.

### `needsSetup` is `false`, but nobody can sign in as admin

**Cause (before 12.4.0):** a creation failed after the user was written (for example a failing account link), and
the user stayed behind without the admin role. Since 12.4.0 such a user is removed again. On an older version, or if
the server log says the partially created user "could not be removed", delete that user and its `account` rows and
retry.

**Cause (a killed setup):** the process was killed between creating the user and finishing it, so no rollback ran.
With `systemSetup.initialAdmin` set to that address and password, restart the instance: the boot finishes the setup
and logs `Finished an interrupted initial-admin setup`. A restart within five minutes of the kill logs that the
claim is still held and retries on its own once it has gone stale. Without `initialAdmin` (the setup ran through the
HTTP init), set it for one start, or delete the user and its `account` rows and run the init again.

### Init returns 403 "System setup not available"

**Two different guards raise this, and the response cannot tell you which.**

**Cause 1 - users already exist.** The ordinary case on a deployment that is already set up.

1. Check `GET /system-setup/status` - `needsSetup` should be `true`
2. If this is a fresh deployment, verify the database is empty

**Cause 2 - the initial-admin setup is claimed.** The marker `{ _id: 'initial-admin' }` in
`system-setup-locks` is held. Either another instance is running the setup right now, or a previous
SUCCESSFUL setup left it behind: it is removed only when creation FAILS.

This is the one that costs time, because the obvious checks all point the other way. `needsSetup` is
computed from the **user count alone**, so it reports `true` while init is refused - step 1 above
confirms a state that is not the problem, and step 2 confirms an empty database that is genuinely
empty.

1. Look at the server log. Since 11.36.5 the service logs a warning naming the collection, the
   release-on-failure semantics and the stale window — on a PostgreSQL default source the
   `lt_locks` row instead.
2. Check the collection directly: `db.getCollection('system-setup-locks').find()` — on PostgreSQL
   `SELECT * FROM lt_locks WHERE id = 'system-setup:initial-admin'`
3. If you reset the database to replay the setup, drop `system-setup-locks` alongside `users` -
   see **Resetting for tests** below. Otherwise wait for the claim to go stale (5 minutes after it
   was taken).

### Resetting for tests

Emptying `users` is not enough - the claim outlives a successful setup. The framework's own reset,
executed on every test run in `tests/stories/system-setup.e2e-spec.ts`:

```typescript
// deleteMany, not drop: dropping `users` would drop its unique email index,
// which is what prevents a duplicate admin.
for (const col of ['users', 'account', 'session', 'system-setup-locks']) {
  await db.collection(col).deleteMany({});
}
```

On a PostgreSQL default source, the same reset (run there by the same suite in the `postgres` project):

```sql
DELETE FROM session; DELETE FROM account; DELETE FROM users;
DELETE FROM lt_locks WHERE id = 'system-setup:initial-admin';
```

### Init returns 403 "System setup requires BetterAuth"

**Cause:** BetterAuth is not configured or not enabled.

**Solutions:**

1. Ensure `betterAuth` is configured in `config.env.ts`
2. Verify BetterAuth is running (check server startup logs)

### Auto-creation not working

**Cause:** Missing, incomplete or misspelled ENV variables.

**Solutions:**

1. Verify both `email` and `password` are set, spelled `NSC__SYSTEM_SETUP__INITIAL_ADMIN__EMAIL` /
   `__PASSWORD` — a camelCase spelling (`NSC__systemSetup__…`) is not read; the boot warns about it
2. Check server logs for `Auto-created initial admin on startup` or warning messages
3. Ensure BetterAuth is fully initialized (check startup logs)

### Endpoints return 404

**Cause:** System setup module is disabled.

**Solutions:**

1. Check that BetterAuth is enabled (system setup requires it)
2. Ensure `systemSetup` is not set to `{ enabled: false }`

---

## Error Codes

| Code      | Key                                | Description                                                |
| --------- | ---------------------------------- | ---------------------------------------------------------- |
| LTNS_0050 | `SYSTEM_SETUP_NOT_AVAILABLE`       | Users already exist, OR the initial-admin setup is claimed |
| LTNS_0051 | `SYSTEM_SETUP_DISABLED`            | System setup is disabled in config                         |
| LTNS_0052 | `SYSTEM_SETUP_BETTERAUTH_REQUIRED` | BetterAuth must be enabled                                 |
| LTNS_0053 | `SYSTEM_SETUP_HTTP_INIT_DISABLED`  | HTTP init not enabled in this environment (12.4.0+)        |
| LTNS_0054 | `SYSTEM_SETUP_TOKEN_INVALID`       | Setup token missing or wrong (12.4.0+)                     |

---

## Related Documentation

- [Integration Checklist](./INTEGRATION-CHECKLIST.md)
- [BetterAuth Module](../better-auth/README.md)
- [Configurable Features Pattern](../../../.claude/rules/configurable-features.md)