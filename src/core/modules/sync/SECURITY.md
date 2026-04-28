# Sync — Security Notes

The offline sync feature was designed so that **every existing security
mechanism in `@lenne.tech/nest-server` continues to apply unchanged**.
No write path bypasses `@Restricted`, `@Roles`, `securityCheck`, or any
of the four standard Mongoose plugins (Tenant / RoleGuard / Audit /
Password). This document catalogues the risks considered during design
and how each is mitigated.

## Threat Model

The sync endpoints accept arbitrary data from authenticated mobile
clients. Threats considered:

1. **Crafted bulk push payload** that tries to elevate roles, set
   foreign tenant IDs, or sneak in restricted fields.
2. **Concurrency races** between multiple devices of the same user.
3. **Cross-tenant ID guessing** — pushing a known ID from another tenant.
4. **Hard-delete escalation** — trying to bypass tombstones via crafted
   service options.
5. **WebSocket data leakage** through the hint subscription.
6. **Denial-of-service** via flooding push or pull endpoints, or
   opening many WS subscriptions.
7. **Idempotency replay** with intentionally reused `clientId`.
8. **Tombstone discovery** via crafted query parameters.

## Mitigations

| ID | Risk | Mitigation |
|----|------|------------|
| R1 | `MapAndValidatePipe` whitelist bypass via generic Body type | Per-item DTO validation in `CoreSyncService` using registered `createDto`/`updateDto` with `class-validator` (`whitelist: true`). Items without a DTO match cannot reach the database. |
| R2 | Soft-delete bypass of `process()` pipeline | `CrudService.delete()` on syncable schemas routes through `update({ deletedAt })`, ensuring `checkRights`, `securityCheck`, and all plugins fire. |
| R3 | Field-level LWW could overwrite `@Restricted` fields | `tryFieldLevelMerge` runs the patch through `checkRights(INPUT)` and re-issues `update()` (full pipeline). `@SyncField('lww') + @Restricted` triggers a bootstrap warning. |
| R4 | `CheckResponseInterceptor` does not run on WS payloads | Hint payload is intentionally minimal: `{ model, changedAt }` only. Tenant ID is internal-only and never reaches the wire. |
| R5 | WS resolver runs without `RequestContext` | Hint resolver does **no DB operations** — it is a passive PubSub fan-out. No context needed. |
| R6 | Cross-tenant push (foreign `id`) | `update()` calls `findById()` which is filtered by `mongooseTenantPlugin`. Foreign IDs return null → `not_found` status. |
| R7 | Privilege escalation via push (`roles`, `tenantId`) | Three layers: DTO whitelist, `checkRights(INPUT)`, `mongooseRoleGuardPlugin` / `mongooseTenantPlugin` as backstops. |
| R8 | DoS via bulk push flooding | `@SyncRateLimit` decorator with token-bucket guard. Defaults: 60 pulls/min, 30 pushes/min per user. Configurable. Override with Redis-backed guard for multi-instance. |
| R9 | WS connection flood | `maxSubscriptionsPerUser` (default 10) — extra subscribes are rejected. |
| R10 | Idempotency replay | `clientId` (UUID) is hashed with `(userId, modelName)`; result is cached for `ttlSeconds`. Repeats return the cached result instead of re-executing. |
| R11 | Cursor manipulation (`cursor=<epoch-0>`) | Not a security issue — tenant filter ensures the user only sees their scope. Performance bound by `maxLimit` cap (1000) and rate limit. |
| R12 | `findChangesSince` with `.lean()` would skip `securityCheck` | Default is non-lean — Mongoose document is returned, REST interceptors filter as usual. Optional `models[].pullLean: true` requires explicit project-level audit (documented). |
| R13 | `_includeDeleted` query parameter exposure | Internal-only flag. Never accepted from HTTP. Hardcoded to `true` in sync code paths, hardcoded to `undefined` everywhere else. |
| R14 | Hard-delete via crafted `serviceOptions` | `CoreSyncService.processItem()` forces `serviceOptions.hardDelete = false`. Hard delete is reachable only from server-side admin code, never from sync push. Verified by `tests/sync-service.e2e-spec.ts`. |
| R15 | Hint subscription as tenant-discovery side-channel | `_tenantId` on payload is never serialised — it lives only in the filter function. No global hint channel reveals tenant existence. |
| R16 | Runtime model registration | `SyncRegistry` is append-only and freezes after `onApplicationBootstrap`. Any later `register()` call throws. |
| R17 | Hint emission on non-syncable schemas | `onApplicationBootstrap` iterates only registered models, not all connection schemas. |
| R18 | `@SyncField('lww') + @Restricted` confusion | Bootstrap-time warning logs the conflict so developers remove the LWW marker. |
| R19 | Concurrent device race on same document | Atomic `findOneAndUpdate({ _id, version })` — MongoDB single-document atomicity. Loser receives 409 + serverState. |
| R20 | Compliance audit trail | `mongooseAuditFieldsPlugin` sets `createdBy`/`updatedBy` per item. Optional `auditLog.enabled` adds a per-operation log collection with optional TTL. |

## Audit Log (R20)

When `sync.auditLog.enabled = true`, every sync operation is recorded
in a separate collection (default `sync_audit_log`) with schema:

```typescript
{
  userId: string;
  modelName: string;
  action: 'pull' | 'create' | 'update' | 'delete';
  itemId?: string;
  clientId?: string;
  result: 'applied' | 'merged' | 'conflict' | ...;
  timestamp: Date;
}
```

Disabled by default for DSGVO/privacy. Enable for compliance-sensitive
deployments. Combine with `auditLog.retentionSeconds` for automatic
expiry.

## Auditor Checklist

When reviewing a project's sync configuration:

- [ ] Each `models[]` entry has both `createDto` and `updateDto`
      registered (or one shared DTO).
- [ ] DTOs use `@UnifiedField` and do not expose `roles`, `tenantId`,
      or other restricted fields.
- [ ] Models with sensitive fields use `@Restricted` on those fields.
- [ ] No `@SyncField('lww')` is combined with a `@Restricted` write
      block.
- [ ] Multi-instance deployments override `pubSub` and `rateLimitGuard`
      with Redis-backed implementations.
- [ ] `_includeDeleted` does not appear in any controller code outside
      of `CoreSyncService` / `CrudService`.
- [ ] No external code path passes `serviceOptions.hardDelete = true`
      from user input.
- [ ] Tombstone TTL index is set on collections with high churn.
- [ ] Rate limits are appropriate for the application's traffic
      profile.
