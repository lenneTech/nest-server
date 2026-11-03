import mongoose from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerModelSchema } from '../../src/core/common/persistence/model-metadata.registry';
import { bindStoreToModel, registerDataStore } from '../../src/core/common/persistence/persistence-runtime.registry';
import { ConfigService } from '../../src/core/common/services/config.service';
import { CoreTenantGuard } from '../../src/core/modules/tenant/core-tenant.guard';
import { CoreTenantService } from '../../src/core/modules/tenant/core-tenant.service';

/**
 * Removing a tenant (12.3.0): `CoreTenantService.deleteAllMembers()` and `purgeTenantData()`.
 *
 * The core had no way to delete a tenant's data. A project had to find every tenant reference itself — `tenantId`
 * paths, the memberships' `tenant`, the AI settings' `scope: 'tenant'` + `refId`, the connections' `tenantIds` list —
 * and the guard kept cached memberships for up to `cacheTtlMs`, so a member of a deleted tenant could write into it.
 */

type Row = Record<string, any>;

/** A store over an in-memory table that understands the filters the purge sends */
class MemoryStore {
  readonly calls: string[] = [];

  constructor(
    readonly name: string,
    public rows: Row[],
  ) {}

  matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, value]) => {
      if (value && typeof value === 'object') {
        if (Array.isArray(value.$all)) {
          return value.$all.every((v: unknown) => (row[key] ?? []).includes(v));
        }
        if (Array.isArray(value.$in)) {
          return value.$in.includes(row[key]);
        }
        if ('$gt' in value) {
          return row[key] > value.$gt;
        }
      }
      return row[key] === value;
    });
  }

  async count(where: Row) {
    this.calls.push(`count ${JSON.stringify(where)}`);
    return this.rows.filter((r) => this.matches(r, where)).length;
  }

  async deleteById(id: string) {
    this.calls.push(`deleteById ${id}`);
    const row = this.rows.find((r) => r.id === id) ?? null;
    this.rows = this.rows.filter((r) => r.id !== id);
    return row;
  }

  async deleteMany(where: Row) {
    this.calls.push(`deleteMany ${JSON.stringify(where)}`);
    this.deleted.push(this.rows.filter((r) => this.matches(r, where)).length);
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !this.matches(r, where));
    return before - this.rows.length;
  }

  /** Rows each deleteMany() call removed */
  readonly deleted: number[] = [];

  async find(where: Row, options: { limit?: number; sort?: Row } = {}) {
    const found = this.rows.filter((r) => this.matches(r, where));
    if (options.sort?.id) {
      found.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
    return options.limit ? found.slice(0, options.limit) : found;
  }

  async updateById(id: string, update: Row) {
    this.calls.push(`updateById ${id} ${JSON.stringify(update)}`);
    const row = this.rows.find((r) => r.id === id);
    Object.assign(row ?? {}, update);
    return row ?? null;
  }
}

function register(name: string, definition: Row, rows: Row[]): MemoryStore {
  registerModelSchema(name, new mongoose.Schema(definition));
  const store = new MemoryStore(name, rows);
  registerDataStore(name, store as any);
  return store;
}

const tenant = 'tenant-a';
const other = 'tenant-b';

function setup() {
  const members = register('TenantMember', { role: String, status: String, tenant: String, user: String }, [
    { id: 'm1', role: 'owner', status: 'active', tenant, user: 'u1' },
    { id: 'm2', role: 'member', status: 'suspended', tenant, user: 'u2' },
    { id: 'm3', role: 'owner', status: 'active', tenant: other, user: 'u3' },
  ]);
  const notes = register('PurgeNote', { tenantId: String, text: String }, [
    { id: 'n1', tenantId: tenant, text: 'a' },
    { id: 'n2', tenantId: other, text: 'b' },
  ]);
  const globals = register('PurgeGlobal', { tenantId: String }, [{ id: 'g1', tenantId: tenant }]);
  const tokens = register('ApiToken', { tenant: String }, [
    { id: 't1', tenant },
    { id: 't2', tenant: other },
  ]);
  const limits = register('AiBudgetLimit', { refId: String, scope: String }, [
    { id: 'b1', refId: tenant, scope: 'tenant' },
    { id: 'b2', refId: tenant, scope: 'user' },
  ]);
  const connections = register('AiConnection', { tenantIds: [String] }, [
    { id: 'c1', tenantIds: [tenant] },
    { id: 'c2', tenantIds: [tenant, other] },
    { id: 'c3', tenantIds: [] },
  ]);
  const guard = { invalidateTenant: vi.fn(), invalidateUser: vi.fn() };
  const service = new CoreTenantService({ modelName: 'TenantMember' } as any, guard as any);
  return { connections, globals, guard, limits, members, notes, service, tokens };
}

describe('CoreTenantService.purgeTenantData()', () => {
  afterEach(() => ConfigService.setConfig({} as any, { reInit: true }));

  /**
   * @regression   12.3.0 — the core could not delete a tenant's data; every project had to find each tenant reference
   *   itself, and missed the ones that are not a `tenantId` path.
   * @seen-failing Skip the reference table in purgeTenantData() (src/core/modules/tenant/core-tenant.service.ts) —
   *   registered as mutation `tenant-purge-skips-references` in tests/regression-mutations.json.
   */
  it("deletes the tenant's rows in every tenant-scoped model and every core reference, and nobody else's", async () => {
    ConfigService.setConfig({ multiTenancy: { excludeSchemas: ['PurgeGlobal'] } } as any, { reInit: true });
    const { globals, limits, members, notes, service, tokens } = setup();

    const report = await service.purgeTenantData(tenant);

    expect(members.rows.map((r) => r.id)).toEqual(['m3']);
    expect(notes.rows.map((r) => r.id)).toEqual(['n2']);
    expect(tokens.rows.map((r) => r.id)).toEqual(['t2']);
    expect(limits.rows.map((r) => r.id)).toEqual(['b2']);
    // excludeSchemas: tenantId there is not ownership
    expect(globals.rows.map((r) => r.id)).toEqual(['g1']);
    expect(report).toMatchObject({ AiBudgetLimit: 1, AiConnection: 2, ApiToken: 1, PurgeNote: 1, TenantMember: 2 });
  });

  /**
   * @regression   12.3.0 — an empty `tenantIds` list means "every tenant": removing the deleted tenant from a list it
   *   was alone in would hand that connection, API key included, to all tenants.
   * @seen-failing Pull the tenant from every list in purgeTenantConnections()
   *   (src/core/modules/tenant/core-tenant.service.ts) — registered as mutation `tenant-purge-frees-connection` in
   *   tests/regression-mutations.json.
   */
  it('deletes a connection only the tenant could use, and only removes the tenant from shared ones', async () => {
    const { connections, service } = setup();

    await service.purgeTenantData(tenant);

    expect(connections.rows).toEqual([
      { id: 'c2', tenantIds: [other] },
      { id: 'c3', tenantIds: [] },
    ]);
  });

  /**
   * @regression   12.3.0 — the members must lose access before the data goes, or one of them writes into the tenant
   *   while it is being deleted.
   * @seen-failing Delete the members after the data in purgeTenantData()
   *   (src/core/modules/tenant/core-tenant.service.ts) — registered as mutation `tenant-purge-members-last` in
   *   tests/regression-mutations.json.
   */
  it('removes the members and clears their cached access before it deletes any data', async () => {
    const { guard, members, notes, service } = setup();
    const order: string[] = [];
    guard.invalidateUser.mockImplementation((user: string) => order.push(`invalidate ${user}`));
    const deleteNotes = notes.deleteMany.bind(notes);
    notes.deleteMany = async (where: Row) => {
      order.push('delete notes');
      return deleteNotes(where);
    };

    await service.purgeTenantData(tenant);

    expect(order.indexOf('delete notes')).toBeGreaterThan(order.indexOf('invalidate u1'));
    expect(guard.invalidateUser.mock.calls.map((c) => c[0]).sort()).toEqual(['u1', 'u2']);
    expect(guard.invalidateTenant).toHaveBeenCalledWith(tenant);
    expect(members.rows.map((r) => r.id)).toEqual(['m3']);
  });

  /**
   * @regression   12.3.0 — one statement over a tenant's rows of a synchronized SQL model holds the model's change lock
   *   until it commits; every other tenant's writes to that model waited for the whole purge.
   * @seen-failing Delete with one deleteMany() instead of deleteInBatches() in purgeTenantRecords()
   *   (src/core/modules/tenant/core-tenant.service.ts) — registered as mutation `tenant-purge-one-statement` in
   *   tests/regression-mutations.json.
   */
  it('deletes a large tenant in batches of at most 1000 records, and only its own', async () => {
    const { notes, service } = setup();
    const id = (n: number) => `n${String(n).padStart(5, '0')}`;
    notes.rows.push(...Array.from({ length: 2500 }, (_, n) => ({ id: id(n), tenantId: tenant, text: 'bulk' })));

    const report = await service.purgeTenantData(tenant);

    expect(report.PurgeNote).toBe(2501);
    expect(notes.rows.map((r) => r.id)).toEqual(['n2']);
    expect(Math.max(...notes.deleted)).toBeLessThanOrEqual(1000);
    expect(notes.deleted.reduce((sum, n) => sum + n, 0)).toBe(2501);
  });

  /**
   * @regression   12.3.0 — a tenant token needs no membership: deleted with the other references after the data, it let
   *   an integration keep writing into the tenant while the purge ran, and those records survived it.
   * @seen-failing Mark the ApiToken entry of TENANT_REFERENCES as not granting access
   *   (src/core/modules/tenant/core-tenant.service.ts) — registered as mutation `tenant-purge-tokens-last` in
   *   tests/regression-mutations.json.
   */
  it("deletes the tenant's API tokens before any data, together with the memberships", async () => {
    const { notes, service, tokens } = setup();
    const order: string[] = [];
    for (const [label, store] of [
      ['tokens', tokens],
      ['notes', notes],
    ] as const) {
      const deleteMany = store.deleteMany.bind(store);
      store.deleteMany = async (where: Row) => {
        order.push(label);
        return deleteMany(where);
      };
    }

    await service.purgeTenantData(tenant);

    expect(order[0]).toBe('tokens');
    expect(order).toContain('notes');
    expect(tokens.rows.map((r) => r.id)).toEqual(['t2']);
  });

  /**
   * @regression   12.3.0 — a model registered only through MongooseModule.forFeature() has no data store; the purge
   *   reaches it through the MongoDB connection, or the tenant's documents there survive.
   * @seen-failing Skip the loop over the connection's models in purgeTenantRecords()
   *   (src/core/modules/tenant/core-tenant.service.ts) — registered as mutation `tenant-purge-skips-mongo-models` in
   *   tests/regression-mutations.json.
   */
  it("deletes the tenant's documents in a MongoDB model no store serves, and nothing in models it already handled", async () => {
    const { members, notes, service } = setup();
    let legacyRows: Row[] = [{ tenantId: tenant }, { tenantId: tenant }, { tenantId: other }];
    const legacy = {
      countDocuments: async (where: Row) => legacyRows.filter((r) => r.tenantId === where.tenantId).length,
      deleteMany: async (where: Row) => {
        const before = legacyRows.length;
        legacyRows = legacyRows.filter((r) => r.tenantId !== where.tenantId);
        return { deletedCount: before - legacyRows.length };
      },
      schema: new mongoose.Schema({ tenantId: String, text: String }),
    };
    const untouchable = () => {
      throw new Error('reached through the connection although a store handled it');
    };
    const bound = (store: MemoryStore) => {
      const model = Object.assign(function BoundModel() {}, {
        deleteMany: untouchable,
        schema: new mongoose.Schema({ tenantId: String }),
      });
      bindStoreToModel(model, store as any);
      return model;
    };
    (service as any).mongoConnection = {
      models: {
        LegacyNote: legacy,
        PurgeNote: bound(notes),
        TenantMember: bound(members),
        Unscoped: { deleteMany: untouchable, schema: new mongoose.Schema({ text: String }) },
      },
    };

    expect(await service.purgeTenantData(tenant, { dryRun: true })).toMatchObject({ LegacyNote: 2 });
    const report = await service.purgeTenantData(tenant);

    expect(report).toMatchObject({ LegacyNote: 2, PurgeNote: 1, TenantMember: 2 });
    expect(legacyRows).toEqual([{ tenantId: other }]);
    expect(notes.rows.map((r) => r.id)).toEqual(['n2']);
  });

  /**
   * @regression   12.3.0 — per-tenant users (a `User` with a `tenantId`) were deleted straight from the store, past the
   *   user service, although the purge promises to leave users alone; their Better-Auth sessions and accounts stayed.
   * @seen-failing Drop the `users` check from the store loop, or from the connection loop, in purgeTenantRecords()
   *   (src/core/modules/tenant/core-tenant.service.ts) — registered as `tenant-purge-deletes-users` and
   *   `tenant-purge-deletes-mongo-users` in tests/regression-mutations.json.
   */
  it('leaves the users table alone, also where users carry a tenantId', async () => {
    const { members, notes, service } = setup();
    registerModelSchema('User', new mongoose.Schema({ email: String, tenantId: String }));
    const users = new MemoryStore('User', [
      { email: 'a@test.com', id: 'u1', tenantId: tenant },
      { email: 'b@test.com', id: 'u2', tenantId: other },
    ]);
    registerDataStore('User', users as any);
    const untouchable = () => {
      throw new Error('deleted from the users collection');
    };
    const bound = (store: MemoryStore, definition: Row) => {
      const model = Object.assign(function BoundModel() {}, { schema: new mongoose.Schema(definition) });
      bindStoreToModel(model, store as any);
      return model;
    };
    (service as any).mongoConnection = {
      models: {
        PurgeNote: bound(notes, { tenantId: String }),
        TenantMember: bound(members, { tenant: String }),
        // Reached only through the connection, as a model registered with MongooseModule.forFeature() is
        Account: {
          deleteMany: untouchable,
          schema: new mongoose.Schema({ tenantId: String }, { collection: 'users' }),
        },
        // Registered with CorePersistenceModule.forFeature(): its Mongoose model is bound to the store
        User: Object.assign(bound(users, { email: String, tenantId: String }), { deleteMany: untouchable }),
      },
    };

    const report = await service.purgeTenantData(tenant);

    expect(report.User).toBeUndefined();
    expect(report.Account).toBeUndefined();
    expect(users.rows.map((r) => r.id)).toEqual(['u1', 'u2']);
    expect(users.calls).toEqual([]);
    expect(notes.rows.map((r) => r.id)).toEqual(['n2']);
  });

  it('counts without deleting in a dry run, and leaves out what the caller excludes', async () => {
    const { members, notes, service, tokens } = setup();

    const report = await service.purgeTenantData(tenant, { dryRun: true, exclude: ['ApiToken'] });

    expect(report).toMatchObject({ AiConnection: 2, PurgeNote: 1, TenantMember: 2 });
    expect(report.ApiToken).toBeUndefined();
    expect(members.rows).toHaveLength(3);
    expect(notes.rows).toHaveLength(2);
    expect(tokens.calls).toEqual([]);
  });

  /**
   * @regression   12.3.0 — `deleteMany({ tenantId: undefined })` matches every document on MongoDB.
   * @seen-failing Drop the check in requireTenantId() (src/core/modules/tenant/core-tenant.service.ts) — registered
   *   as mutation `tenant-purge-accepts-empty-id` in tests/regression-mutations.json.
   */
  it.each([undefined, '', '   ', { $ne: null }])('refuses the tenant id %j without touching anything', async (id) => {
    const { members, notes, service } = setup();

    await expect(service.purgeTenantData(id as any)).rejects.toThrow(/tenantId/);
    await expect(service.deleteAllMembers(id as any)).rejects.toThrow(/tenantId/);
    expect(members.rows).toHaveLength(3);
    expect(notes.rows).toHaveLength(2);
  });
});

describe('CoreTenantGuard.invalidateTenant()', () => {
  /**
   * @regression   12.3.0 — invalidateTenant() forgot only the isTenantActive answer; the members' cached memberships
   *   kept a deleted tenant reachable for up to cacheTtlMs.
   * @seen-failing Drop the membership eviction from clearTenant() (src/core/modules/tenant/core-tenant.guard.ts) —
   *   registered as mutation `tenant-invalidate-keeps-memberships` in tests/regression-mutations.json.
   */
  it("forgets the tenant's cached memberships and the tenant lists that contain it, nothing else", () => {
    const guard = new CoreTenantGuard({} as any, {} as any);
    const memberships: Map<string, any> = (guard as any).membershipCache;
    const tenantIds: Map<string, any> = (guard as any).tenantIdsCache;
    const entry = { expiresAt: Date.now() + 60_000, result: { role: 'member' } };
    memberships.set(`u1:${tenant}`, entry);
    memberships.set(`u2:${tenant}`, entry);
    memberships.set(`u1:${other}`, entry);
    tenantIds.set('u1', { expiresAt: Date.now() + 60_000, ids: [tenant, other] });
    tenantIds.set('u3', { expiresAt: Date.now() + 60_000, ids: [other] });

    guard.invalidateTenant(tenant);

    expect([...memberships.keys()]).toEqual([`u1:${other}`]);
    expect([...tenantIds.keys()]).toEqual(['u3']);
    guard.onModuleDestroy?.();
  });
});
