# System Setup Module

Initial admin user creation for fresh deployments of @lenne.tech/nest-server.

## TL;DR

```typescript
// config.env.ts - enable system setup endpoints
systemSetup: {},

// Requires BetterAuth to be enabled
betterAuth: {
  // ...
},
```

**Quick Links:** [Integration Checklist](./INTEGRATION-CHECKLIST.md) | [Endpoints](#endpoints) | [Configuration](#configuration) | [Security](#security)

---

## Table of Contents

- [Purpose](#purpose)
- [Endpoints](#endpoints)
- [Configuration](#configuration)
- [Security](#security)
- [Frontend Integration](#frontend-integration)
- [Troubleshooting](#troubleshooting)

---

## Purpose

When a system is freshly deployed (zero users in the database), there is no way to create an initial admin user - especially when BetterAuth's `disableSignUp` is enabled. This module provides two public REST endpoints:

1. **Status check** - Does the system need initial setup?
2. **Init** - Create the first admin user

Once any user exists, the init endpoint is permanently locked (returns 403).

---

## Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/system-setup/status` | Check if system needs setup |
| POST | `/api/system-setup/init` | Create initial admin user |

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

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `email` | string | Yes | Valid email format |
| `password` | string | Yes | Minimum 8 characters |
| `name` | string | No | Defaults to email prefix |

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

Follows the ["Presence implies enabled"](../../../.claude/rules/configurable-features.md) pattern:

| Config | Effect |
|--------|--------|
| `systemSetup: undefined` | Disabled (default, backward compatible) |
| `systemSetup: {}` | Enabled |
| `systemSetup: { enabled: false }` | Disabled explicitly |

```typescript
// config.env.ts
{
  systemSetup: {},

  betterAuth: {
    emailAndPassword: {
      disableSignUp: true, // System setup bypasses this
    },
  },
}
```

---

## Security

1. **Zero-user guard** - Init only works when `countDocuments({}) === 0`
2. **Opt-in only** - Module not loaded unless `systemSetup` is configured
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

### Endpoints return 404

**Cause:** System setup module is not loaded.

**Solutions:**
1. Add `systemSetup: {}` to `config.env.ts`
2. Verify the module is imported (check server startup logs for `CoreSystemSetupController`)

---

## Error Codes

| Code | Key | Description |
|------|-----|-------------|
| LTNS_0050 | `SYSTEM_SETUP_NOT_AVAILABLE` | Users already exist, setup locked |
| LTNS_0051 | `SYSTEM_SETUP_DISABLED` | System setup is disabled in config |
| LTNS_0052 | `SYSTEM_SETUP_BETTERAUTH_REQUIRED` | BetterAuth must be enabled |

---

## Related Documentation

- [Integration Checklist](./INTEGRATION-CHECKLIST.md)
- [BetterAuth Module](../better-auth/README.md)
- [Configurable Features Pattern](../../../.claude/rules/configurable-features.md)
