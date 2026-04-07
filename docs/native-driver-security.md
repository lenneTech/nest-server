# Native MongoDB Driver Access — Security Policy

## Problem

Mongoose registers plugins (Tenant isolation, Audit fields, RoleGuard, Password hashing, ID transformation) as pre/post hooks on schema operations. These hooks **only** fire on Mongoose Model methods — not on the native MongoDB driver.

Three access paths bypass all plugins:

```typescript
// Path 1: model.collection.* (native driver via Mongoose Model)
await this.userModel.collection.insertOne(doc);     // No tenantId, no audit, no password hash

// Path 2: model.db (Mongoose Connection → native Db → native MongoClient)
await this.userModel.db.db.collection('users').insertOne(doc);  // Same problem

// Path 3: connection.db.collection() (native driver via injected Connection)
await this.connection.db.collection('users').insertOne(doc);  // Same problem
```

### What Gets Bypassed

| Plugin | Function | Risk When Bypassed |
|--------|---------|---------------------|
| **Tenant Plugin** | Sets tenantId on new documents, filters queries | Data leak between tenants |
| **Audit Plugin** | Sets createdBy/updatedBy | No traceability |
| **RoleGuard Plugin** | Prevents role escalation | Privilege escalation |
| **Password Plugin** | Hashes passwords (bcrypt) | Plaintext passwords in DB |
| **ID Plugin** | Transforms _id to id | Inconsistent API responses |

---

## Protection: Three Layers

### Layer 1: TypeScript Type Guard in CrudService

`mainDbModel` is blocked via `Omit<Model, 'collection' | 'db'>` type (`SafeModel`):

```typescript
this.mainDbModel.find(...)           // Works
this.mainDbModel.insertMany(...)     // Works
this.mainDbModel.collection          // TypeScript error
this.mainDbModel.db                  // TypeScript error

this.getNativeCollection('reason')   // Escape hatch for native Collection, with logging
this.getNativeConnection('reason')           // Escape hatch for Mongoose Connection, with logging
```

**`getNativeCollection(reason)`** and **`getNativeConnection(reason)`** are the only ways to access the native driver from CrudService-based services. They:
- Require a reason (string parameter)
- Log a `[SECURITY]` warning on every access
- Throw an error if no reason is provided

### Layer 2: CLAUDE.md Rules

Documented in `nest-server/CLAUDE.md`, `nest-server-starter/CLAUDE.md`, and `lt-monorepo/CLAUDE.md`:
- `model.collection.*` is forbidden
- `connection.db.collection()` only for schema-less collections
- Mongoose Model methods as alternatives

### Layer 3: AI Review Rules

Review agents (backend-reviewer, security-reviewer, code-reviewer) check on every review:
- `.collection.` access on Mongoose Models → Security risk (HIGH)
- `.db.collection()` on tenant-scoped collections → Security risk
- `.db.collection()` on schema-less collections → Allowed

---

## Secure Alternatives

| Forbidden (native driver) | Allowed (Mongoose — plugins active) |
|--------------------------|-------------------------------------|
| `collection.insertOne(doc)` | `Model.insertMany([doc])` |
| `collection.bulkWrite(ops)` | `Model.bulkWrite(ops)` |
| `collection.updateOne(f, u)` | `Model.updateOne(f, u)` |
| `collection.updateMany(f, u)` | `Model.updateMany(f, u)` |
| `collection.deleteOne(f)` | `Model.deleteOne(f)` |
| `collection.deleteMany(f)` | `Model.deleteMany(f)` |
| `collection.find(f)` | `Model.find(f)` or `Model.find(f).lean()` |
| `collection.findOne(f)` | `Model.findOne(f)` or `Model.findOne(f).lean()` |
| `collection.aggregate(p)` | `Model.aggregate(p)` |
| `collection.countDocuments(f)` | `Model.countDocuments(f)` |

**Performance:** Mongoose Model methods have minimal overhead compared to the native driver — the plugins themselves cost < 0.1ms per call (see `docs/process-performance-optimization.md`).

---

## Allowed Cases for connection.db.collection()

| Use Case | Example | Why Allowed |
|----------|---------|-------------|
| Schema-less collections | `db.collection('mcp_oauth_clients')` | No Mongoose schema, no tenantId field |
| BetterAuth tables | `db.collection('session')`, `db.collection('account')` | IAM infrastructure, not tenant-scoped |
| Read-only aggregations | `db.collection('incidents').countDocuments({tenantId, ...})` | Read-only, manual tenant filter |
| Admin operations | `db.collection('users').createIndex(...)` | Index management, no CRUD |
| DevOps/Backup | `db.collection(name).drop()` | One-time admin actions |

### Not Allowed

```typescript
// Write on tenant-scoped collection without Mongoose
await this.connection.db.collection('orders').insertOne({ ... });
// → await this.orderModel.insertMany([{ ... }]);

// Read without tenant filter on tenant-scoped data
await this.connection.db.collection('orders').find({}).toArray();
// → await this.orderModel.find({});  // Tenant plugin filters automatically
```

---

## getNativeCollection() / getNativeConnection() Reference

```typescript
// Definitions in CrudService:
protected getNativeCollection(reason: string): Collection
protected getNativeConnection(reason: string): Connection

// Usage — native Collection:
const col = this.getNativeCollection('Migration: Bulk import of historical data without tenant context');
await col.insertOne(doc);

// Usage — native Db (for cross-collection reads, schema-less collections):
const conn = this.getNativeConnection('Statistics: count chatmessages across all tenants');
const count = await conn.db.collection('chatmessages').countDocuments({ ... });

// Without reason → Error:
this.getNativeCollection('');  // throws Error
this.getNativeConnection('');          // throws Error

// Logging:
// [SECURITY] Native collection access: Migration: Bulk import... (Model: MonitorCheck)
// [SECURITY] Native db access: Statistics: count chatmessages... (Model: Statistics)
```

---

## Review Checklist

When reviewing code (manual or AI), check for `.collection.` and `.db.collection(`:

```
1. Is it model.collection.* ?
   → ALWAYS a security risk. Use getNativeCollection() or Model method.

2. Is it connection.db.collection('name') ?
   → Does the collection have a Mongoose schema with tenantId?
     YES → Security violation. Use Mongoose Model.
     NO  → Continue to 3.
   → Are data being written?
     YES → Verify tenantId/audit is set manually.
     NO  → Allowed (read-only).
```
