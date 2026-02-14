# Permissions Module Integration Checklist

## Reference Implementation

- Local: `node_modules/@lenne.tech/nest-server/src/server/` (scanned at runtime)
- GitHub: https://github.com/lenneTech/nest-server/tree/develop/src/core/modules/permissions

## Quick Setup

The Permissions module requires **no files to create** in the consuming project. It only needs a configuration entry.

### 1. Enable in config.env.ts

Add the `permissions` property to your environment configuration:

```typescript
// config.env.ts - local/development only
permissions: true,
```

**WHY only dev/local?** This is a development tool that exposes security metadata. It should never run in production.

### 2. Verify (Optional)

Start your server and navigate to:

- `http://localhost:3000/permissions` - HTML dashboard
- `http://localhost:3000/permissions/json` - Raw JSON

## Configuration Options

| Config                               | Access     | Description                                          |
| ------------------------------------ | ---------- | ---------------------------------------------------- |
| `true`                               | Admin only | Default, requires `RoleEnum.ADMIN` at `/permissions` |
| `{ role: 'S_EVERYONE' }`             | Any role   | Custom role for access                               |
| `{ role: false }`                    | No auth    | No authentication required                           |
| `{ path: 'admin/permissions' }`      | Admin only | Custom endpoint path (default: `permissions`)        |
| `{ role: false, path: 'dev/perms' }` | No auth    | Custom path + no auth                                |
| `{ enabled: false }`                 | Disabled   | Explicitly disabled                                  |
| `undefined`                          | Disabled   | Default (not configured)                             |

## Verification Checklist

- [ ] `permissions: true` added to local/dev config only
- [ ] Server starts without errors
- [ ] `/permissions` returns HTML dashboard (requires admin login)
- [ ] `/permissions/json` returns JSON report
- [ ] Production config does NOT include `permissions`

## Common Mistakes

| Mistake                      | Symptom                            | Fix                                                          |
| ---------------------------- | ---------------------------------- | ------------------------------------------------------------ |
| Enabled in production config | Security metadata exposed publicly | Only enable in `local` / `dev` environments                  |
| Missing admin token          | 401 Unauthorized on `/permissions` | Login as admin first, or use `{ role: false }` for local dev |
| No modules found             | Empty report                       | Ensure `src/server/modules/` exists with module directories  |