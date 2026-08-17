import { Prop, Schema, SchemaFactory, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model } from 'mongoose';

import { mongooseTenantPlugin } from '../src/core/common/plugins/mongoose-tenant.plugin';
import { ConfigService } from '../src/core/common/services/config.service';
import { IRequestContext, RequestContext } from '../src/core/common/services/request-context.service';
import { CoreTenantGuard } from '../src/core/modules/tenant/core-tenant.guard';
import { CoreTenantMemberModel } from '../src/core/modules/tenant/core-tenant-member.model';
import { CoreTenantService } from '../src/core/modules/tenant/core-tenant.service';
import { TenantMemberStatus } from '../src/core/modules/tenant/core-tenant.enums';
import { deriveTestDbUri } from './db-lifecycle.reporter';

/**
 * Tenant DATA isolation — the property medical data actually rests on.
 *
 * Written thesis-first: every `it()` below states something the framework is BELIEVED to
 * guarantee, and was run before any fix so the reds identify real defects rather than confirming a
 * design that was already correct. Where a thesis turned out to hold, the test stays as a
 * regression anchor — a guarantee nobody verified is a guarantee nobody can rely on.
 *
 * The role-level boundary (who may act) lives in tenant-guard.e2e-spec.ts. This file is about which
 * ROWS a request can reach, which is the more consequential half: the role gap needed a malicious
 * tenant owner, a data gap needs only a developer writing a report.
 */

@Schema({ timestamps: true })
class Record {
  @Prop({ type: String })
  tenantId: string;

  @Prop({ required: true, type: String })
  diagnosis: string;

  @Prop({ type: String })
  patientRef: string;
}
const RecordSchema = SchemaFactory.createForClass(Record);

@Schema({ timestamps: true })
class Patient {
  @Prop({ type: String })
  tenantId: string;

  @Prop({ required: true, type: String })
  name: string;
}
const PatientSchema = SchemaFactory.createForClass(Patient);

@Schema({ timestamps: true })
class TenantMember extends CoreTenantMemberModel {}
const TenantMemberSchema = SchemaFactory.createForClass(TenantMember);
TenantMemberSchema.index({ tenant: 1, user: 1 }, { unique: true });

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const USER_A = 'user-a';
const USER_B = 'user-b';

describe('Tenant data isolation (e2e)', () => {
  let app: import('@nestjs/common').INestApplication;
  let recordModel: Model<Record>;
  let patientModel: Model<Patient>;
  let memberModel: Model<TenantMember>;
  let tenantService: CoreTenantService;

  /** Run as a member of one tenant, exactly as CoreTenantGuard would have set it up. */
  const asTenant = <T>(tenantId: string, userId: string, fn: () => Promise<T>): Promise<T> =>
    RequestContext.run({ currentUser: { id: userId, roles: [] }, tenantId } as unknown as IRequestContext, fn);

  beforeAll(async () => {
    new ConfigService({ multiTenancy: { excludeSchemas: [] } } as any);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(deriveTestDbUri('tiso'), {
          connectionFactory: (connection) => {
            connection.plugin(mongooseTenantPlugin);
            return connection;
          },
        }),
        MongooseModule.forFeature([
          { name: Record.name, schema: RecordSchema },
          { name: Patient.name, schema: PatientSchema },
          { name: 'TenantMember', schema: TenantMemberSchema },
        ]),
      ],
      providers: [CoreTenantService, CoreTenantGuard],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    recordModel = moduleFixture.get(getModelToken(Record.name));
    patientModel = moduleFixture.get(getModelToken(Patient.name));
    memberModel = moduleFixture.get(getModelToken('TenantMember'));
    tenantService = moduleFixture.get(CoreTenantService);
  });

  beforeEach(async () => {
    await RequestContext.runWithBypassTenantGuard(async () => {
      await recordModel.deleteMany({});
      await patientModel.deleteMany({});
      await memberModel.deleteMany({});

      const [patientA, patientB] = await patientModel.create([
        { name: 'Patient A', tenantId: TENANT_A },
        { name: 'Patient B', tenantId: TENANT_B },
      ]);
      await recordModel.create([
        { diagnosis: 'own-diagnosis', patientRef: patientA.id, tenantId: TENANT_A },
        { diagnosis: 'FOREIGN-diagnosis', patientRef: patientB.id, tenantId: TENANT_B },
      ]);
    });
  });

  afterAll(async () => {
    await RequestContext.runWithBypassTenantGuard(async () => {
      await recordModel.deleteMany({});
      await patientModel.deleteMany({});
      await memberModel.deleteMany({});
    });
    await app.close();
    new ConfigService({} as any);
  });

  // ===========================================================================
  // A) Write paths — can a request place or move a row into another tenant?
  // ===========================================================================
  describe('A) write paths', () => {
    /**
     * THESIS: a caller-supplied `tenantId` cannot place a row in a FOREIGN tenant.
     *
     * The save hook only sets tenantId when the document does not already carry one
     * ("intentional asymmetry" per its comment). That is correct for system writes, but it means a
     * value that reaches the document survives — so the question is whether an explicit foreign
     * tenantId is refused, or silently honoured.
     */
    /**
     * @regression   11.35.0 — the plugin stamped tenantId only when absent and filtered WHERE but
     *   not the update payload, so a caller-supplied tenantId planted a row in a foreign tenant and
     *   an update could move an existing row out of its own.
     * @seen-failing Make assertOwnTenant() return unconditionally in
     *   src/core/common/plugins/mongoose-tenant.plugin.ts — registered as mutation
     *   `cross-tenant-writes-accepted` in tests/regression-mutations.json.
     */
    it('refuses to create a row in a foreign tenant when tenantId is supplied explicitly', async () => {
      await asTenant(TENANT_A, USER_A, async () => {
        await expect(
          recordModel.create({ diagnosis: 'planted', tenantId: TENANT_B }),
        ).rejects.toThrow();
      });

      const planted = await RequestContext.runWithBypassTenantGuard(() =>
        recordModel.findOne({ diagnosis: 'planted' }).lean().exec(),
      );
      expect(planted, 'a row was created inside tenant B by a tenant A request').toBeNull();
    });

    /**
     * THESIS: an existing row cannot be MOVED to another tenant.
     *
     * The query hook constrains WHERE, not the update payload. So a caller can legitimately find
     * their own row and then rewrite its tenantId — exfiltrating it into a tenant they control, or
     * simply making it vanish for its rightful owner.
     */
    it('refuses to move an existing row into another tenant via update', async () => {
      await asTenant(TENANT_A, USER_A, async () => {
        await expect(
          recordModel.updateOne({ diagnosis: 'own-diagnosis' }, { tenantId: TENANT_B }).exec(),
        ).rejects.toThrow();
      });

      const moved = await RequestContext.runWithBypassTenantGuard(() =>
        recordModel.findOne({ diagnosis: 'own-diagnosis' }).lean().exec(),
      );
      expect(moved?.tenantId, 'the row was moved out of tenant A').toBe(TENANT_A);
    });

    /** THESIS: the same protection holds for the $set operator form. */
    it('refuses a tenant move expressed through $set', async () => {
      await asTenant(TENANT_A, USER_A, async () => {
        await expect(
          recordModel.findOneAndUpdate({ diagnosis: 'own-diagnosis' }, { $set: { tenantId: TENANT_B } }).exec(),
        ).rejects.toThrow();
      });

      const moved = await RequestContext.runWithBypassTenantGuard(() =>
        recordModel.findOne({ diagnosis: 'own-diagnosis' }).lean().exec(),
      );
      expect(moved?.tenantId).toBe(TENANT_A);
    });

    /** THESIS: insertMany cannot plant foreign-tenant rows either. */
    it('refuses insertMany with an explicit foreign tenantId', async () => {
      await asTenant(TENANT_A, USER_A, async () => {
        await expect(
          recordModel.insertMany([{ diagnosis: 'bulk-planted', tenantId: TENANT_B }]),
        ).rejects.toThrow();
      });

      const planted = await RequestContext.runWithBypassTenantGuard(() =>
        recordModel.findOne({ diagnosis: 'bulk-planted' }).lean().exec(),
      );
      expect(planted).toBeNull();
    });

    /** THESIS: writing WITHOUT a tenantId still lands in the caller's own tenant (no regression). */
    it('still stamps the own tenant on a normal create', async () => {
      const created = await asTenant(TENANT_A, USER_A, () =>
        recordModel.create({ diagnosis: 'normal-write' }),
      );
      expect(created.tenantId).toBe(TENANT_A);
    });
  });

  // ===========================================================================
  // B) Aggregation write stages — $out / $merge move rows between collections
  // ===========================================================================
  describe('B) aggregation write stages', () => {
    /**
     * THESIS: $merge cannot be used to copy rows into a collection the caller then reads
     * unfiltered, nor to overwrite another tenant's rows.
     *
     * $out/$merge are the only aggregation stages that WRITE. The plugin filters reads; if these
     * are unguarded, an aggregation can launder data across the boundary.
     */
    it('refuses $merge from within a tenant context', async () => {
      await asTenant(TENANT_A, USER_A, async () => {
        await expect(
          recordModel.aggregate([{ $merge: { into: patientModel.collection.name } }]).exec(),
        ).rejects.toThrow();
      });
    });

    it('refuses $out from within a tenant context', async () => {
      await asTenant(TENANT_A, USER_A, async () => {
        await expect(
          recordModel.aggregate([{ $out: patientModel.collection.name }]).exec(),
        ).rejects.toThrow();
      });
    });
  });

  // ===========================================================================
  // C) populate — a join by another name
  // ===========================================================================
  describe('C) populate', () => {
    /**
     * THESIS: populate is filtered, because it runs through `find` internally and the query hook
     * therefore fires for the referenced model.
     *
     * Assumed rather than verified until now — and the $lookup finding is exactly the case where
     * "it goes through the normal path" turned out to be false.
     */
    it('does not populate a document from another tenant', async () => {
      const foreignPatientId = await RequestContext.runWithBypassTenantGuard(async () => {
        const p = await patientModel.findOne({ tenantId: TENANT_B }).lean().exec();
        // Point a tenant-A record at a tenant-B patient — the shape a stale or malicious ref takes.
        await recordModel.updateOne({ diagnosis: 'own-diagnosis' }, { patientRef: p!._id.toString() }).exec();
        return p!._id.toString();
      });

      const populated: any = await asTenant(TENANT_A, USER_A, () =>
        recordModel
          .findOne({ diagnosis: 'own-diagnosis' })
          .populate({ model: patientModel, path: 'patientRef' })
          .exec(),
      );

      expect(foreignPatientId).toBeTruthy();
      expect(
        populated?.patientRef?.name,
        'populate returned a document belonging to another tenant',
      ).not.toBe('Patient B');
    });
  });

  // ===========================================================================
  // D) Read paths that are easy to forget
  // ===========================================================================
  describe('D) other read paths', () => {
    /** THESIS: distinct() is filtered — it is in the hook list, so foreign values must not appear. */
    it('does not return foreign values through distinct', async () => {
      const values = await asTenant(TENANT_A, USER_A, () => recordModel.distinct('diagnosis').exec());
      expect(values).not.toContain('FOREIGN-diagnosis');
      expect(values).toContain('own-diagnosis');
    });

    /** THESIS: a tenant-scoped read without any tenant context is refused, not served unfiltered. */
    it('refuses a tenant-scoped read with no tenant context at all', async () => {
      await expect(
        RequestContext.run({ currentUser: { id: USER_A, roles: [] } } as unknown as IRequestContext, () =>
          recordModel.find().exec(),
        ),
      ).rejects.toThrow(/Tenant context required/);
    });
  });

  // ===========================================================================
  // E) Bypass containment
  // ===========================================================================
  describe('E) bypass containment', () => {
    /**
     * THESIS: the bypass does not outlive the callback it was opened for.
     *
     * It is AsyncLocalStorage-based, so a leak would not be a stray variable but a context that
     * survives an await boundary — which is exactly the kind of thing that looks fine in review.
     */
    it('does not leak out of the callback that opened it', async () => {
      await RequestContext.run(
        { currentUser: { id: USER_A, roles: [] }, tenantId: TENANT_A } as unknown as IRequestContext,
        async () => {
          const all = await RequestContext.runWithBypassTenantGuard(() => recordModel.find().lean().exec());
          expect(all.length, 'bypass should see both tenants').toBe(2);

          // Immediately after, the same context must be filtered again.
          const mine = await recordModel.find().lean().exec();
          expect(mine.map((r) => r.diagnosis)).toEqual(['own-diagnosis']);
        },
      );
    });

    /** THESIS: a nested bypass restores the OUTER state rather than clearing it entirely. */
    it('restores the surrounding context after a nested bypass', async () => {
      await RequestContext.runWithBypassTenantGuard(async () => {
        await RequestContext.runWithBypassTenantGuard(async () => {
          expect(RequestContext.isBypassTenantGuard()).toBe(true);
        });
        expect(RequestContext.isBypassTenantGuard(), 'outer bypass was cleared by the inner one').toBe(true);
      });
    });
  });

  // ===========================================================================
  // F) Membership cache
  // ===========================================================================
  describe('F) membership cache', () => {
    /**
     * THESIS: the cache is keyed per (user, tenant) — one user's membership must never answer for
     * another user, and one tenant's must never answer for another tenant.
     */
    it('does not serve one user membership to a different user', async () => {
      await tenantService.addMember(TENANT_A, USER_A, 'member');
      const guard = app.get(CoreTenantGuard);

      const forA = await (guard as any).findMembershipCached(USER_A, TENANT_A);
      const forB = await (guard as any).findMembershipCached(USER_B, TENANT_A);

      expect(forA?.user).toBe(USER_A);
      expect(forB, 'a non-member received a cached membership').toBeFalsy();
    });

    it('does not serve a membership of one tenant for another tenant', async () => {
      await tenantService.addMember(TENANT_A, USER_A, 'member');
      const guard = app.get(CoreTenantGuard);

      await (guard as any).findMembershipCached(USER_A, TENANT_A);
      const crossTenant = await (guard as any).findMembershipCached(USER_A, TENANT_B);

      expect(crossTenant, 'a membership leaked across tenants through the cache').toBeFalsy();
    });

    /**
     * THESIS: a role change invalidates the cache, so a demotion takes effect rather than lingering
     * for the cache TTL (30s by default).
     */
    it('reflects a role change instead of serving the stale cached role', async () => {
      await tenantService.addMember(TENANT_A, USER_A, 'owner');
      // A second owner, so demoting the first is allowed — "cannot demote the last owner" is a
      // deliberate rule and would otherwise mask what this test is actually about.
      await tenantService.addMember(TENANT_A, USER_B, 'owner');
      const guard = app.get(CoreTenantGuard);

      const before = await (guard as any).findMembershipCached(USER_A, TENANT_A);
      expect(before?.role).toBe('owner');

      await tenantService.updateMemberRole(TENANT_A, USER_A, 'member');

      const after = await (guard as any).findMembershipCached(USER_A, TENANT_A);
      expect(after?.role, 'the demotion was not visible — stale cache').toBe('member');
    });

    /** THESIS: removing a member invalidates the cache too. */
    it('reflects a removal instead of serving the stale cached membership', async () => {
      await tenantService.addMember(TENANT_A, USER_A, 'member');
      const guard = app.get(CoreTenantGuard);

      await (guard as any).findMembershipCached(USER_A, TENANT_A);
      await tenantService.removeMember(TENANT_A, USER_A);

      const after = await (guard as any).findMembershipCached(USER_A, TENANT_A);
      expect(
        after && after.status === TenantMemberStatus.ACTIVE,
        'a removed member was still served as active from the cache',
      ).toBeFalsy();
    });
  });
});
