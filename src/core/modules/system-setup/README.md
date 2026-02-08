# System Setup Module

Initial admin user creation for fresh deployments of @lenne.tech/nest-server.

## TL;DR

System setup is **enabled by default** when BetterAuth is active. No configuration needed.

For automated deployments (Docker, CI/CD), set initial admin credentials via ENV:

```bash
NSC__systemSetup__initialAdmin__email=admin@example.com
NSC__systemSetup__initialAdmin__password=YourSecurePassword123!
```

**Quick Links:** [Integration Checklist](./INTEGRATION-CHECKLIST.md) | [Endpoints](#endpoints) | [Configuration](#configuration) | [Security](#security)

---

## Table of Contents

- [Purpose](#purpose)
- [Endpoints](#endpoints)
- [Configuration](#configuration)
- [Auto-Creation via Config/ENV](#auto-creation-via-configenv)
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

| Method | Endpoint                   | Description                 |
| ------ | -------------------------- | --------------------------- |
| GET    | `/api/system-setup/status` | Check if system needs setup |
| POST   | `/api/system-setup/init`   | Create initial admin user   |

### GET /api/system-setup/status

Returns the current setup status.

**Response:**

```json
{
  "needsSetup": true,
  "betterAuthEnabled": true
}
```

### POST /api/system-setup/init

Creates the initial admin user. Only works when zero users exist.

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
  "message": "LTNS_0050: System setup not available - users already exist"
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
NSC__systemSetup__initialAdmin__email=admin@example.com
NSC__systemSetup__initialAdmin__password=YourSecurePassword123!
NSC__systemSetup__initialAdmin__name=Admin  # optional
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
- Race conditions between multiple instances are handled gracefully

### Security Best Practices

1. **Remove credentials after first deployment** - Once the admin exists, the ENV vars are unused
2. **Use secrets management** - Docker Secrets, Kubernetes Secrets, Vault, etc.
3. **Never commit credentials** - Use `.env` files (gitignored) or external secret stores
4. **Use strong passwords** - Minimum 8 characters, recommended 16+

---

## Security

1. **Zero-user guard** - Init only works when `countDocuments({}) === 0`
2. **Enabled by default** - Safe because endpoints are permanently locked once any user exists
3. **Race condition protection** - MongoDB unique email index prevents duplicates
4. **Permanent lock** - Once any user exists, init returns 403
5. **BetterAuth required** - Returns 403 if BetterAuth is not enabled

### How It Bypasses disableSignUp

The service uses BetterAuth's `$context.internalAdapter.createUser()` directly, which is the same approach used by Better-Auth's own admin plugin. This bypasses the `disableSignUp` flag while still creating proper BetterAuth accounts.

---

## Frontend Integration

Typical frontend flow:

```typescript
// 1. Check if setup is needed
const status = await fetch('/api/system-setup/status');
const { needsSetup } = await status.json();

if (needsSetup) {
  // 2. Show setup form and submit
  const result = await fetch('/api/system-setup/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

**Cause:** Users already exist in the database.

**Solutions:**

1. Check `GET /api/system-setup/status` - `needsSetup` should be `true`
2. If this is a fresh deployment, verify the database is empty

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

| Code      | Key                                | Description                        |
| --------- | ---------------------------------- | ---------------------------------- |
| LTNS_0050 | `SYSTEM_SETUP_NOT_AVAILABLE`       | Users already exist, setup locked  |
| LTNS_0051 | `SYSTEM_SETUP_DISABLED`            | System setup is disabled in config |
| LTNS_0052 | `SYSTEM_SETUP_BETTERAUTH_REQUIRED` | BetterAuth must be enabled         |

---

## Related Documentation

- [Integration Checklist](./INTEGRATION-CHECKLIST.md)
- [BetterAuth Module](../better-auth/README.md)
- [Configurable Features Pattern](../../../.claude/rules/configurable-features.md)