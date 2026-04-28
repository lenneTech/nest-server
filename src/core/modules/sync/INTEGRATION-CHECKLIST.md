# Sync — Integration Checklist

Step-by-step guide for adopting the offline sync feature in a project
that uses `@lenne.tech/nest-server`.

## Prerequisites

- `@lenne.tech/nest-server` ≥ 11.26.0
- A model that should support offline sync (typically your domain
  entity — `Note`, `Task`, `Order`, etc.)

## Step 1 — Mark the schema as syncable

In your model file, add `syncable: true` to the `@Schema(...)` options:

```typescript
@Schema({ syncable: true, timestamps: true })
export class Note extends CorePersistenceModel {
  @Prop({ type: String })
  @UnifiedField({ description: 'Note title' })
  title: string;

  @Prop({ type: String })
  @UnifiedField({ description: 'Note body' })
  body: string;

  // OPTIONAL: declare version/deletedAt explicitly to control defaults.
  // The plugin will add them automatically if you omit these declarations.
  @Prop({ type: Number, default: 1 })
  version: number;

  @Prop({ type: Date, default: null })
  deletedAt: Date | null;
}
```

## Step 2 — (Optional) Tag fields with conflict strategies

For each field where last-write-wins is acceptable, decorate it. Default
is `'strict'` (any conflict raises 409).

```typescript
import { SyncField } from '@lenne.tech/nest-server';

export class Note {
  @SyncField('lww')                // server picks newer updatedAt on conflict
  title: string;

  @SyncField('strict')             // any divergence → 409
  body: string;

  // No decorator → defaults to 'strict'.
}
```

**Important:** Do not use `@SyncField('lww')` on a field that is also
`@Restricted(...)` for write — restricted-write blocks the field anyway,
making LWW ineffective. The framework logs a warning at bootstrap if
this combination is detected.

## Step 3 — Enable sync in `config.env.ts`

```typescript
import { NoteService } from './modules/note/note.service';
import { NoteCreateInput } from './modules/note/inputs/note-create.input';
import { NoteInput } from './modules/note/inputs/note.input';

export const config: IServerOptions = {
  // ... existing config ...

  sync: {
    enabled: true,
    models: [
      {
        name: 'Note',
        service: NoteService,
        createDto: NoteCreateInput,
        updateDto: NoteInput,
        // Optional per-model overrides:
        // pullLean: true,                      // memory optimisation
        // maxPushBatch: 50,                    // tighter than global
        // onConflict: async (ctx) => { ... },  // custom telemetry
      },
    ],
  },
};
```

For a quick smoke test you can use the boolean shorthand `sync: true` —
the plugin activates but no models are registered until you add them.

## Step 4 — Migrate existing data (only if model already had data)

Existing documents have no `version` and no `deletedAt`. Two options:

### Option A — One-shot migration (recommended)

Add a migration script under `src/migrations/`:

```typescript
// src/migrations/2026-04-28-add-sync-fields-to-note.ts
import mongoose from 'mongoose';

export const up = async () => {
  const conn = mongoose.connection;
  await conn.collection('notes').updateMany(
    { version: { $exists: false } },
    { $set: { version: 1, deletedAt: null } },
  );
};
```

Run via your migration runner (`@lenne.tech/nest-server` ships
`MigrateModule`).

### Option B — Lazy migration

Skip the script. The first write through `CrudService.update()` will
trigger the plugin to inject `$inc.version`, and Mongoose will create
the field set to `1`. `deletedAt` defaults to `null` from the schema.
The cursor pull works either way because it filters on `updatedAt`,
which all existing documents already have.

Trade-off: until every document has been written at least once, mixed
states exist (some with version, some without). For deterministic
cursor stability, Option A is preferred.

## Step 5 — Wire up the client

The mobile client uses two REST endpoints and one WebSocket subscription.

### Initial sync

```
GET /sync/Note?limit=200
```

Response includes `cursor`. Persist locally, then loop with
`?cursor=<persisted>&limit=200` until `hasMore: false`.

### Listening for new changes

```graphql
subscription {
  syncHint(model: "Note") {
    model
    changedAt
  }
}
```

When a hint arrives, do another `GET /sync/Note?cursor=<latest>`.

### Pushing local changes

```
POST /sync/Note
Content-Type: application/json

{
  "items": [
    { "clientId": "uuid-1", "data": { "title": "New" } },
    { "clientId": "uuid-2", "id": "abc123", "version": 3, "data": { "title": "Edit" } },
    { "clientId": "uuid-3", "id": "def456", "version": 1, "deleted": true }
  ]
}
```

`clientId` is a UUID generated locally per item. Persist the response so
that retries on network failures dedupe via the idempotency cache.

## Step 6 — Multi-instance deployments

If your backend runs as multiple replicas (Kubernetes, ECS), do TWO things:

1. **Replace the in-memory PubSub** with Redis-backed PubSub:

```typescript
// In the consuming app's module setup:
import { RedisPubSub } from 'graphql-redis-subscriptions';

CoreModule.forRoot(config, {
  sync: {
    pubSub: new RedisPubSub({ connection: { host: 'redis', port: 6379 } }),
  },
});
```

Without this, hints fire only on the instance where the mutation
happened — clients connected to other instances miss them.

2. **Replace the rate-limit guard** with a Redis-based implementation
   that shares state across instances:

```typescript
// Project-side: implement RedisSyncRateLimitGuard extends SyncRateLimitGuard
CoreModule.forRoot(config, {
  sync: {
    rateLimitGuard: RedisSyncRateLimitGuard,
  },
});
```

Without this, each instance maintains its own bucket — the effective
rate limit becomes `max × instances`.

## Step 7 — Optional: tombstone TTL

Tombstones live forever by default (clients depend on them to mirror
deletions). If you want automatic cleanup after, e.g., 30 days:

```typescript
NoteSchema.index({ deletedAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });
```

Add this **outside** `@Schema(...)` after `SchemaFactory.createForClass(...)`.

## Step 8 — Verification

Smoke test in your CI / staging:

1. Pull initial — receive expected items with `version`, `cursor`.
2. Push a create — verify `applied` status and document in DB.
3. Push an update with stale `version` — expect `conflict` + `serverState`.
4. Push a delete — verify `deletedAt` set and item disappears from
   regular queries.
5. Verify subscription delivers hints after each mutation.
6. Verify another tenant cannot pull or push your data (404s).

## Common pitfalls

- **Forgetting to register the DTO** — bulk push items will fail with
  `invalid` status because there is no schema to validate against.
- **Setting `_includeDeleted: true` from a controller** — this is an
  internal flag and is never accepted as a query parameter. If you
  need to query tombstones programmatically, use `findChangesSince`
  or call the underlying Mongoose query with `setOptions`.
- **Hard-deleting through sync push** — not possible by design. If you
  truly need GDPR-style deletion, do it programmatically in an admin
  endpoint with `serviceOptions.hardDelete: true`.
- **Mixing `@SyncField('lww')` with `@Restricted(...)` write blocks** —
  the framework warns at bootstrap; remove the LWW marker.
- **Running under heavy parallel CI** — sync uses TTL indexes for
  idempotency. CI test suites that wipe the DB between runs are fine,
  but make sure the cleanup hooks honour `_includeDeleted: true` so
  tombstones are also cleared.
