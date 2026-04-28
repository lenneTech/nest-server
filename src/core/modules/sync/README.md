# Offline Sync Module

Generic, opt-in offline sync support for `@lenne.tech/nest-server`. Designed
for mobile clients (typically React Native + SQLite) that need to read and
write while disconnected and reconcile with the server when connectivity
returns.

## Architecture

Three orthogonal layers, each opt-in:

1. **Schema layer** — `mongooseSyncPlugin` adds `version` (auto-increment)
   and `deletedAt` (tombstones) to schemas marked `@Schema({ syncable: true })`,
   plus a compound cursor index `{ updatedAt: 1, _id: 1 }`. Tombstones are
   automatically filtered from regular reads.

2. **Service layer** — `CrudService` gains optional `expectedVersion` for
   optimistic-concurrency CAS, soft-delete that goes through the regular
   `update()` pipeline (preserving `@Restricted`, `securityCheck`, audit
   plugins), and a new `findChangesSince(cursor, options)` for delta pulls.

3. **Transport layer** — `CoreSyncController` (`GET/POST /sync/:model`) and
   `CoreSyncResolver` (GraphQL subscription `syncHint` for "changes
   available" notifications). Both can be individually disabled via config.

## Activation

Three steps to enable sync for a model:

```typescript
// 1. Mark the schema as syncable
@Schema({ syncable: true, timestamps: true })
export class Note extends CoreModel {
  @Prop() title: string;
  @Prop() body: string;

  // Plugin auto-adds these — declaring them is optional but lets you set
  // defaults / typings:
  @Prop({ type: Number, default: 1 }) version: number;
  @Prop({ type: Date, default: null }) deletedAt: Date | null;
}

// 2. Enable sync in your app's config.env.ts
{
  // ... other config ...
  sync: {
    models: [
      {
        name: 'Note',
        service: NoteService,
        createDto: NoteCreateInput,
        updateDto: NoteInput,
      },
    ],
  },
}

// 3. (Optional) tag fields with conflict strategies
@SyncField('lww') title: string;     // last-write-wins per field
@SyncField('strict') body: string;   // any conflict raises 409 (default)
```

## REST API

### `GET /sync/:model?cursor=<base64>&limit=<n>`

Returns the next window of changes (creates, updates, tombstones)
strictly newer than `cursor`. Cursor is opaque base64. Without `cursor`,
returns the initial snapshot.

Response:
```json
{
  "changes": [
    { "_id": "...", "title": "...", "version": 3, "deletedAt": null, "updatedAt": "..." },
    { "_id": "...", "deletedAt": "2026-04-28T...", "version": 5, "updatedAt": "..." }
  ],
  "cursor": "eyJ1IjoiMjAyNi0w...",
  "hasMore": true
}
```

### `POST /sync/:model`

Bulk push. Body: `{ items: ISyncPushItem[] }`. Each item:

```json
{
  "clientId": "uuid-v4",            // optional, enables idempotency
  "id": "<existing-id>",            // omit for create
  "version": 3,                     // required for update/delete
  "deleted": true,                  // optional, soft-delete
  "data": { "title": "..." }        // payload (validated against DTO)
}
```

Response: 200 OK with per-item status array. Possible statuses:
- `applied` — clean write
- `merged` — field-level LWW resolved a conflict
- `conflict` — strict 409, `serverVersion` and `serverState` provided
- `not_found` — document does not exist or is not visible (e.g. wrong tenant)
- `invalid` — DTO validation failed
- `error` — other server-side failure

## GraphQL Subscription

```graphql
subscription {
  syncHint(model: "Note") {
    model
    changedAt
  }
}
```

Hints carry only the model name and a timestamp — no actual data and
**no tenant ID**. The resolver filters per subscriber so users only see
hints for tenants they belong to. Server-side debounce (default 250 ms)
collapses bursts of mutations into a single hint.

## Configuration Reference

See [`src/core/common/interfaces/server-options.interface.ts`](../../common/interfaces/server-options.interface.ts)
`ISyncConfig` for the full type. Highlights:

| Key | Default | Purpose |
|-----|---------|---------|
| `enabled` | `false` | Master toggle |
| `defaultLimit` / `maxLimit` | 200 / 1000 | Pull page sizing |
| `maxPushBatch` | 200 | Push batch cap |
| `pathPrefix` | `'sync'` | REST route prefix |
| `hint.debounceMs` | 250 | Hint emission debounce |
| `hint.maxSubscriptionsPerUser` | 10 | WS connection cap |
| `pull.enabled` / `push.enabled` / `hint.enabled` | true | Per-leg toggles |
| `pull.auth.roles` / `push.auth.roles` / `hint.auth.roles` | `[S_USER]` | Per-leg auth |
| `rateLimit.pull` / `rateLimit.push` | 60/min, 30/min | Token-bucket per user |
| `idempotency.enabled` / `idempotency.ttlSeconds` | true / 86400 | Retry deduplication |
| `auditLog.enabled` | false | DSGVO-aware default |
| `fields.version` / `fields.deletedAt` | `'version'` / `'deletedAt'` | Field-name overrides |
| `models[].pullLean` | false | Memory-optimised pull (security trade-off) |
| `models[].onConflict` | none | Custom conflict callback |

Multi-instance deployments override `ICoreModuleOverrides.sync.pubSub`
with a Redis-backed implementation, and `rateLimitGuard` with a Redis
token bucket.

## Backward Compatibility

When `config.sync` is `undefined` or `false`:

- The Mongoose plugin is not registered.
- No new fields are added to any schema.
- No new indexes are created.
- `CrudService.update()` and `delete()` use their pre-sync code paths.
- `CoreSyncModule` is not imported.

Existing projects update to the new version with zero behavioural change.
See `tests/sync-backward-compat.e2e-spec.ts` for the verification suite.

## Security

See [`SECURITY.md`](./SECURITY.md) for the full mitigations table.
TL;DR — every write goes through `CrudService` →`process()` →
`@Restricted` / `@Roles` / `mongooseTenantPlugin` /
`mongooseRoleGuardPlugin` / `mongooseAuditFieldsPlugin` /
`CheckResponseInterceptor` / `CheckSecurityInterceptor`. Hard delete
is not reachable through the sync push endpoint. WebSocket hints are
filtered per tenant before emission.

## Integration Checklist

See [`INTEGRATION-CHECKLIST.md`](./INTEGRATION-CHECKLIST.md) for the
step-by-step adoption guide.
