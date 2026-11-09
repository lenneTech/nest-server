# System Setup Module

Initial admin user creation for fresh deployments of @lenne.tech/nest-server.

## TL;DR

System setup is **enabled by default** when BetterAuth is active. Locally (`local`, `ci`, `e2e`) no configuration is
needed. On every other environment the anonymous `POST /system-setup/init` is **closed** since 11.46.0 (see
[HTTP init](#http-init-systemsetuphttpinit)); a deployment creates its first admin from `initialAdmin`.

For automated deployments (Docker, CI/CD), set initial admin credentials via ENV:

```bash
NSC__SYSTEM_SETUP__INITIAL_ADMIN__EMAIL=admin@example.com
NSC__SYSTEM_SETUP__INITIAL_ADMIN__PASSWORD=YourSecurePassword123!
```

**Quick Links:** [Integration Checklist](./INTEGRATION-CHECKLIST.md) | [Endpoints](#endpoints) | [Configuration](#configuration) | [Security](#security)

---

## Table of Contents

- [Purpose](#purpose)
- [Endpoints](#endpoints)
- [Configuration](#configuration)
- [Auto-Creation via Config/ENV](#auto-creation-via-configenv)
- [HTTP init (`systemSetup.httpInit`)](#http-init-systemsetuphttpinit)
- [Security](#security)
- [Frontend Integration](#frontend-integration)
- [Troubleshooting](#troubleshooting)

---

## Purpose

When a system is freshly deployed (zero users in the database), there is no way to create an initial admin user - especially when BetterAuth's `disableSignUp` is enabled. This module provides:

1. **REST endpoints** - Manual admin creation via API call
2. **Auto-creation** - Automatic admin creation on server start via config/ENV

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

`httpInitEnabled` / `httpInitTokenRequired` (11.46.0+) say whether `POST /system-setup/init` is open here and whether
it needs the setup token. Offer a setup form only when `needsSetup && httpInitEnabled`.

### POST /system-setup/init

Creates the initial admin user. Only works when zero users exist, and only where `systemSetup.httpInit` opens it — by
default in `local`, `ci` and `e2e` (403 `LTNS_0053` elsewhere). With a configured token the request carries it in the
`X-System-Setup-Token` header (403 `LTNS_0054` without it or with a wrong one).

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

---

## Configuration

System setup is **enabled by default** when BetterAuth is active:

| Config                                   | Effect                              |
| ---------------------------------------- | ----------------------------------- |
| _(not set)_                              | Enabled (when BetterAuth is active) |
| `systemSetup: { enabled: false }`        | Disabled explicitly                 |
| `systemSetup: { initialAdmin: { ... } }` | Enabled with auto-creation          |

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

## Auto-Creation via Config/ENV

For automated deployments where no manual REST call is possible (Docker, CI/CD, Kubernetes), configure initial admin credentials via environment variables:

### Via NSC Environment Variables

```bash
NSC__SYSTEM_SETUP__INITIAL_ADMIN__EMAIL=admin@example.com
NSC__SYSTEM_SETUP__INITIAL_ADMIN__PASSWORD=YourSecurePassword123!
NSC__SYSTEM_SETUP__INITIAL_ADMIN__NAME=Admin  # optional
```

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

### Security Best Practices

1. **Remove credentials after first deployment** - Once the admin exists, the ENV vars are unused
2. **Use secrets management** - Docker Secrets, Kubernetes Secrets, Vault, etc.
3. **Never commit credentials** - Use `.env` files (gitignored) or external secret stores
4. **Use strong passwords** - Minimum 8 characters, recommended 16+

---

## HTTP init (`systemSetup.httpInit`)

Since 11.46.0 (backport of 12.4.0) the anonymous init is fail-closed outside the local environments: whoever reaches
an API without users through it would become its administrator.

| `systemSetup.httpInit` | `local` / `ci` / `e2e` | every other environment |
|---|---|---|
| not set | open | **closed** — 403 `LTNS_0053` |
| `true` (`NSC__SYSTEM_SETUP__HTTP_INIT=true`) | open | open, without a token |
| `{ token }` (`NSC__SYSTEM_SETUP__HTTP_INIT__TOKEN`, at least 16 characters) | open, token required | open, token required |
| `false` / `{ enabled: false }` | closed | closed |

The environment is the configured `env`, but where that is local only because 11.x fell back to the `local` block (a
`NODE_ENV` without a block of its own, or an empty one), `NODE_ENV` decides — such a stage counts as deployed
(`resolveSystemSetupEnv()`). A token that is missing, empty, shorter than 16 characters or not a string keeps the init
closed and logs an error at boot; a non-boolean, non-object value counts as not set. `initialAdmin` is not affected. A deployed instance that starts
with zero users, no usable `initialAdmin` and a closed init logs an error naming both ways in. While the init is closed,
`setupSwagger()` leaves it out of the document.

A project controller that overrides `createInitialAdmin()` must call `systemSetupService.assertHttpInitAllowed(token)`
first; `createInitialAdmin()` itself is not gated, because the boot path calls it too. Migration:
[11.45.x → 11.46.x](../../../../migration-guides/11.45.x-to-11.46.x.md).

## Security

1. **Fail-closed HTTP init** - the anonymous init is open only where `systemSetup.httpInit` allows it (by default
   `local`, `ci`, `e2e`)
2. **Zero-user guard** - Init requires `countDocuments({}) === 0`. Necessary but not sufficient:
   the atomic claim below must also be winnable, so an empty `users` collection alone does not
   re-open setup
3. **Enabled by default** - Safe because the init is closed on deployed environments unless opened, and locked once
   any user exists
4. **Race condition protection** - MongoDB unique email index prevents duplicates; auto-creation on
   bootstrap is additionally claimed atomically via the `system-setup-locks` marker
5. **Permanent lock** - Once any user exists, init returns 403
6. **BetterAuth required** - Returns 403 if BetterAuth is not enabled
7. **Rollback** - a creation that fails after the user was written removes that user again (11.46.0+), so the setup can
   be retried

### How It Bypasses disableSignUp

The service uses BetterAuth's `$context.internalAdapter.createUser()` directly, which is the same approach used by Better-Auth's own admin plugin. This bypasses the `disableSignUp` flag while still creating proper BetterAuth accounts.

---

## Frontend Integration

Typical frontend flow:

```typescript
// 1. Check if setup is needed
const status = await fetch('/system-setup/status');
// A backend older than 11.46.0 sends neither httpInit field: treat that as "available"
const { needsSetup, httpInitEnabled = true, httpInitTokenRequired = false } = await status.json();

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
   release-on-failure semantics and the stale window.
2. Check the collection directly: `db.getCollection('system-setup-locks').find()`
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

### Init returns 403 "System setup requires BetterAuth"

**Cause:** BetterAuth is not configured or not enabled.

**Solutions:**

1. Ensure `betterAuth` is configured in `config.env.ts`
2. Verify BetterAuth is running (check server startup logs)

### Auto-creation not working

**Cause:** Missing or incomplete ENV variables.

**Solutions:**

1. Verify both `email` and `password` are set
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

---

## Related Documentation

- [Integration Checklist](./INTEGRATION-CHECKLIST.md)
- [BetterAuth Module](../better-auth/README.md)
- [Configurable Features Pattern](../../../.claude/rules/configurable-features.md)