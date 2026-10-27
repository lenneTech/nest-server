import { ForbiddenException } from '@nestjs/common';
import mongoose, { Connection, Model } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { mongooseTenantPlugin } from '../src/core/common/plugins/mongoose-tenant.plugin';
import { ConfigService } from '../src/core/common/services/config.service';
import { IRequestContext, RequestContext } from '../src/core/common/services/request-context.service';
import { deriveTestDbUri } from './db-lifecycle.reporter';

/**
 * The after-layer of tenant isolation, against a real MongoDB.
 *
 * The read filter keeps foreign rows out on every correct path, so the row check can only be observed when
 * the filter is wrong. The test model therefore gets a pre hook AFTER the tenant plugin that switches the
 * request's tenant: the plugin builds its filter for tenant A, the query returns A's rows, and the check
 * afterwards runs for tenant B — the shape of a filter built with the wrong scope.
 */
describe('tenant row check after reads (e2e)', () => {
  let connection: Connection;
  let Doc: Model<any>;
  let Plain: Model<any>;

  const inTenant = <T>(tenantId: string, fn: () => Promise<T>): Promise<T> =>
    RequestContext.run({ fromRequest: true, tenantId } as IRequestContext, fn);

  beforeAll(async () => {
    ConfigService.setConfig({ multiTenancy: {} } as any, { reInit: true });
    connection = await mongoose.createConnection(deriveTestDbUri('tenant-row-check')).asPromise();

    const scopeSwitch = function () {
      const context = RequestContext.get() as any;
      if (context?.switchTo) {
        context.tenantId = context.switchTo;
      }
    };

    const docSchema = new mongoose.Schema({ name: String, tenantId: String });
    docSchema.plugin(mongooseTenantPlugin);
    // Registered after the plugin, so it runs after the plugin's filter was built
    docSchema.pre('find', scopeSwitch);
    docSchema.pre('findOne', scopeSwitch);
    Doc = connection.model('RowCheckDoc', docSchema);

    const plainSchema = new mongoose.Schema({ name: String, tenantId: String });
    plainSchema.plugin(mongooseTenantPlugin);
    Plain = connection.model('RowCheckPlain', plainSchema);
  });

  beforeEach(async () => {
    await Doc.deleteMany({});
    await Plain.deleteMany({});
    await Doc.insertMany([
      { name: 'a1', tenantId: 'A' },
      { name: 'b1', tenantId: 'B' },
    ]);
    await Plain.insertMany([
      { name: 'a1', tenantId: 'A' },
      { name: 'b1', tenantId: 'B' },
    ]);
  });

  afterAll(async () => {
    await connection?.dropDatabase();
    await connection?.close();
    ConfigService.setConfig({} as any, { reInit: true });
  });

  const switched = <T>(fn: () => Promise<T>): Promise<T> =>
    RequestContext.run({ fromRequest: true, switchTo: 'B', tenantId: 'A' } as any, fn);

  /**
   * @regression   DEV-3828 (db-agnostic phase 0) — the tenant row check is the after-layer every data store
   *   shares; on MongoDB it is the tenant plugin's post hooks. Without them a read whose filter was built
   *   for the wrong tenant returns that tenant's rows.
   * @seen-failing Remove the `schema.post(hookName, …)` row-check loop from
   *   src/core/common/plugins/mongoose-tenant.plugin.ts — registered as mutation
   *   `tenant-row-check-not-registered` in tests/regression-mutations.json.
   */
  it('withholds the result of find() when it contains another tenant’s rows (lean and hydrated)', async () => {
    await expect(switched(() => Doc.find({}).lean().exec())).rejects.toBeInstanceOf(ForbiddenException);
    await expect(switched(() => Doc.find({}).exec())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('withholds the result of findOne() the same way', async () => {
    await expect(switched(() => Doc.findOne({ name: 'a1' }).lean().exec())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('passes every correctly filtered read unchanged', async () => {
    const own = await inTenant('A', () => Plain.find({}).lean().exec());
    expect(own.map((doc: any) => doc.name)).toEqual(['a1']);
    const one = await inTenant('B', () => Plain.findOne({}).exec());
    expect(one?.name).toBe('b1');
  });

  it('passes a projection that leaves tenantId out — it cannot be verified, the filter applied', async () => {
    const own = await inTenant('A', () => Plain.find({}).select('name').lean().exec());
    expect(own.map((doc: any) => doc.name)).toEqual(['a1']);
  });

  it('checks nothing for system work without a request context', async () => {
    const all = await Plain.find({}).lean().exec();
    expect(all).toHaveLength(2);
  });
});
