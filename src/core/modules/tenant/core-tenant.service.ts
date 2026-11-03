import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectConnection, InjectModel } from '../../common/persistence/mongo/mongoose-compat.js';
import type { Connection, Model } from 'mongoose';

import { looksLikeGlobalOnlyRole, looksLikeSystemRole, SYSTEM_ROLE_PREFIX } from '../../common/enums/role.enum.js';
import type { DataStore } from '../../common/persistence/data-store.interface.js';
import { getModelDescriptors } from '../../common/persistence/model-metadata.registry.js';
import { getModelStore, getStoreForModel } from '../../common/persistence/persistence-runtime.registry.js';
import { ConfigService } from '../../common/services/config.service.js';
import { RequestContext } from '../../common/services/request-context.service.js';
import {
  AI_BUDGET_LIMIT_MODEL,
  AI_CONNECTION_MODEL,
  AI_CONNECTION_PREFERENCE_MODEL,
  AI_TOOL_GRANT_MODEL,
  AI_TOOL_POLICY_MODEL,
} from '../ai/core-ai.constants.js';
import { API_TOKEN_MODEL_TOKEN } from '../api-token/core-api-token.constants.js';
import { CoreTenantMemberModel } from './core-tenant-member.model.js';
import { routedMemberStore } from './core-tenant-member.store.js';
import { DEFAULT_ROLE_HIERARCHY, TENANT_MEMBER_MODEL_TOKEN, TenantMemberStatus } from './core-tenant.enums.js';
import { CoreTenantGuard } from './core-tenant.guard.js';

/**
 * Core service for tenant membership operations.
 *
 * Projects should extend this service via the Module Inheritance Pattern
 * to add custom logic (e.g., tenant creation, invitation flows).
 *
 * @example
 * ```typescript
 * @Injectable()
 * export class TenantService extends CoreTenantService {
 *   override async addMember(tenantId: string, userId: string, role?: string) {
 *     const member = await super.addMember(tenantId, userId, role);
 *     // Custom: send notification email
 *     await this.notificationService.sendInvite(userId, tenantId);
 *     return member;
 *   }
 * }
 * ```
 */
@Injectable()
export class CoreTenantService {
  protected readonly logger = new Logger(CoreTenantService.name);

  /**
   * The MongoDB connection, `null` without MongoDB. `purgeTenantData()` reads the models registered only through
   * `MongooseModule.forFeature()` from it. Injected as a property, so a subclass constructor needs no change
   */
  @Optional()
  @InjectConnection()
  protected readonly mongoConnection?: Connection | null;

  constructor(
    @InjectModel(TENANT_MEMBER_MODEL_TOKEN) protected readonly memberModel: Model<CoreTenantMemberModel>,
    @Optional() protected readonly tenantGuard?: CoreTenantGuard,
  ) {}

  /** The membership store when the model is routed to SQL; `undefined` keeps the Mongoose path (MongoDB) */
  protected get memberStore(): DataStore<any> | undefined {
    return routedMemberStore(this.memberModel);
  }

  /**
   * Get the configured role hierarchy.
   */
  protected getHierarchy(): Record<string, number> {
    return ConfigService.configFastButReadOnly?.multiTenancy?.roleHierarchy ?? DEFAULT_ROLE_HIERARCHY;
  }

  /**
   * Get the default (lowest) role name from the hierarchy.
   */
  protected getDefaultRole(): string {
    const hierarchy = this.getHierarchy();
    const entries = Object.entries(hierarchy);
    if (entries.length === 0) return 'member';
    return entries.reduce((a, b) => (a[1] <= b[1] ? a : b))[0];
  }

  /**
   * Get the highest role name from the hierarchy.
   */
  protected getHighestRole(): string {
    const hierarchy = this.getHierarchy();
    const entries = Object.entries(hierarchy);
    if (entries.length === 0) return 'owner';
    return entries.reduce((a, b) => (a[1] >= b[1] ? a : b))[0];
  }

  /**
   * Find all active tenant memberships for a user.
   */
  async findMemberships(userId: string): Promise<CoreTenantMemberModel[]> {
    if (this.memberStore) {
      return this.memberStore.find({ status: TenantMemberStatus.ACTIVE, user: userId }) as Promise<
        CoreTenantMemberModel[]
      >;
    }
    return this.memberModel.find({ status: TenantMemberStatus.ACTIVE, user: userId }).lean().exec() as Promise<
      CoreTenantMemberModel[]
    >;
  }

  /**
   * Get a single membership REGARDLESS of its status.
   *
   * Read the name literally: a removal is a status change to `SUSPENDED`, not
   * a delete, so this still answers for somebody who was thrown out. That is
   * deliberate and `addMember` depends on it — it reactivates the existing row
   * instead of creating a duplicate.
   *
   * It is therefore the WRONG method for an authorization check. Asking "is
   * this user a member with role X?" through it answers yes for a removed
   * member, and a route that guards itself this way keeps granting a
   * suspended administrator the right to invite, remove and re-role — the very
   * rights that being removed was supposed to take away. Routes that carry
   * `@SkipTenantCheck()` and decide for themselves are exactly the ones at
   * risk, because the tenant guard never sees them.
   *
   * For an authorization check use {@link getActiveMembership}.
   */
  async getMembership(tenantId: string, userId: string): Promise<CoreTenantMemberModel | null> {
    if (this.memberStore) {
      return this.memberStore.findOne({ tenant: tenantId, user: userId }) as Promise<CoreTenantMemberModel | null>;
    }
    return this.memberModel
      .findOne({ tenant: tenantId, user: userId })
      .lean()
      .exec() as Promise<CoreTenantMemberModel | null>;
  }

  /**
   * Get a membership only while it is live — the one to use when deciding what
   * somebody may do.
   *
   * Returns `null` for a suspended or invited membership, so "removed" means
   * removed everywhere, not just for the data the tenant guard happens to
   * cover.
   */
  async getActiveMembership(tenantId: string, userId: string): Promise<CoreTenantMemberModel | null> {
    if (!tenantId?.trim() || !userId?.trim()) {
      return null;
    }

    const where = { status: TenantMemberStatus.ACTIVE, tenant: tenantId, user: userId };
    if (this.memberStore) {
      return this.memberStore.findOne(where) as Promise<CoreTenantMemberModel | null>;
    }
    return this.memberModel.findOne(where).lean().exec() as Promise<CoreTenantMemberModel | null>;
  }

  /**
   * Add a member to a tenant.
   * Uses bypassTenantGuard to avoid tenant filtering on the membership collection itself.
   *
   * @param role - Role name from the configured hierarchy. Defaults to the lowest role.
   */
  async addMember(
    tenantId: string,
    userId: string,
    role?: string,
    invitedById?: string,
  ): Promise<CoreTenantMemberModel> {
    if (!tenantId?.trim()) {
      throw new BadRequestException('tenantId must not be empty');
    }
    if (!userId?.trim()) {
      throw new BadRequestException('userId must not be empty');
    }
    const effectiveRole = role ?? this.getDefaultRole();
    assertAssignableMembershipRole(effectiveRole);

    // Check for existing membership
    const existing = await this.getMembership(tenantId, userId);
    if (existing) {
      if (existing.status === TenantMemberStatus.ACTIVE) {
        throw new BadRequestException('User is already an active member of this tenant');
      }
      // Reactivate suspended/invited membership
      return RequestContext.runWithBypassTenantGuard(async () => {
        const reactivation = {
          invitedBy: invitedById,
          joinedAt: new Date(),
          role: effectiveRole,
          status: TenantMemberStatus.ACTIVE,
        };
        const result = (
          this.memberStore
            ? await this.memberStore.updateOne({ tenant: tenantId, user: userId }, reactivation)
            : await this.memberModel
                .findOneAndUpdate({ tenant: tenantId, user: userId }, reactivation, { returnDocument: 'after' })
                .lean()
                .exec()
        ) as CoreTenantMemberModel;
        this.tenantGuard?.invalidateUser(userId);
        return result;
      });
    }

    return RequestContext.runWithBypassTenantGuard(async () => {
      const member = {
        invitedBy: invitedById,
        joinedAt: new Date(),
        role: effectiveRole,
        status: TenantMemberStatus.ACTIVE,
        tenant: tenantId,
        user: userId,
      };
      if (this.memberStore) {
        const created = await this.memberStore.insert(member);
        this.tenantGuard?.invalidateUser(userId);
        return created as CoreTenantMemberModel;
      }
      const doc = await this.memberModel.create(member);
      this.tenantGuard?.invalidateUser(userId);
      return doc.toObject() as CoreTenantMemberModel;
    });
  }

  /**
   * Remove a member from a tenant (sets status to SUSPENDED).
   * Prevents removing the last owner (highest role).
   */
  async removeMember(tenantId: string, userId: string): Promise<CoreTenantMemberModel> {
    if (!tenantId?.trim()) {
      throw new BadRequestException('tenantId must not be empty');
    }
    if (!userId?.trim()) {
      throw new BadRequestException('userId must not be empty');
    }
    await this.assertNotLastOwner(tenantId, userId);

    return RequestContext.runWithBypassTenantGuard(async () => {
      const where = { status: TenantMemberStatus.ACTIVE, tenant: tenantId, user: userId };
      const result = this.memberStore
        ? await this.memberStore.updateOne(where, { status: TenantMemberStatus.SUSPENDED })
        : await this.memberModel
            .findOneAndUpdate(where, { status: TenantMemberStatus.SUSPENDED }, { returnDocument: 'after' })
            .lean()
            .exec();

      if (!result) {
        throw new NotFoundException('Membership not found');
      }

      this.tenantGuard?.invalidateUser(userId);
      return result as CoreTenantMemberModel;
    });
  }

  /**
   * Update a member's role within a tenant.
   * Prevents demoting the last owner (highest role).
   */
  async updateMemberRole(tenantId: string, userId: string, role: string): Promise<CoreTenantMemberModel> {
    if (!tenantId?.trim()) {
      throw new BadRequestException('tenantId must not be empty');
    }
    if (!userId?.trim()) {
      throw new BadRequestException('userId must not be empty');
    }
    if (!role?.trim()) {
      throw new BadRequestException('role must not be empty');
    }
    assertAssignableMembershipRole(role);
    const highestRole = this.getHighestRole();

    // If demoting from highest role, ensure it's not the last one. Active
    // only: a suspended membership is not an owner any more, and letting it
    // trigger the guard produces "cannot demote the last owner" for a user who
    // is not even a member.
    const existing = await this.getActiveMembership(tenantId, userId);
    if (existing?.role === highestRole && role !== highestRole) {
      await this.assertNotLastOwner(tenantId, userId);
    }

    return RequestContext.runWithBypassTenantGuard(async () => {
      const where = { status: TenantMemberStatus.ACTIVE, tenant: tenantId, user: userId };
      const result = this.memberStore
        ? await this.memberStore.updateOne(where, { role })
        : await this.memberModel.findOneAndUpdate(where, { role }, { returnDocument: 'after' }).lean().exec();

      if (!result) {
        throw new NotFoundException('Active membership not found');
      }

      this.tenantGuard?.invalidateUser(userId);
      return result as CoreTenantMemberModel;
    });
  }

  /**
   * Ensure the given user is not the last owner (highest role) of the tenant.
   * Throws BadRequestException if removing/demoting them would leave the tenant without an owner.
   *
   * Note: This uses a read-check-act pattern which has a theoretical TOCTOU race under
   * concurrent requests. For production environments with high concurrency, consider using
   * MongoDB transactions (requires replica set) in your extended service.
   */
  async assertNotLastOwner(tenantId: string, userId: string): Promise<void> {
    const highestRole = this.getHighestRole();

    return RequestContext.runWithBypassTenantGuard(async () => {
      const owners = { role: highestRole, status: TenantMemberStatus.ACTIVE, tenant: tenantId };
      const ownerCount = this.memberStore
        ? await this.memberStore.count(owners)
        : await this.memberModel.countDocuments(owners);

      if (ownerCount <= 1) {
        const membership = await this.getActiveMembership(tenantId, userId);
        if (membership?.role === highestRole) {
          throw new BadRequestException('Cannot remove or demote the last owner of a tenant');
        }
      }
    });
  }

  /**
   * Delete every membership of a tenant, whatever its status, and clear what the tenant guard cached for it.
   *
   * Meant for removing a tenant: unlike {@link removeMember} it deletes the rows instead of suspending them and skips
   * the last-owner check, because the tenant itself goes. Every affected user is invalidated in the guard (on every
   * replica with Redis), the tenant last. Answers how many memberships went.
   */
  async deleteAllMembers(tenantId: string): Promise<number> {
    requireTenantId(tenantId);
    return RequestContext.runWithBypassTenantGuard(async () => {
      const where = { tenant: tenantId };
      const store = this.memberDataStore();
      const members = store ? await store.find(where) : await this.memberModel.find(where).select('user').lean().exec();
      const deleted = store ? await store.deleteMany(where) : (await this.memberModel.deleteMany(where)).deletedCount;
      for (const userId of new Set(members.map((member) => String(member.user)))) {
        this.tenantGuard?.invalidateUser(userId);
      }
      this.tenantGuard?.invalidateTenant(tenantId);
      return deleted;
    });
  }

  /**
   * Delete everything the framework knows to belong to a tenant. Answers how many records went per model (models with
   * none are left out); with `dryRun` it only counts.
   *
   * First every way in ({@link endTenantAccess}): the memberships ({@link deleteAllMembers}) and the tenant's API
   * tokens (`tenant`), which need no member — so nobody writes into the tenant while its data goes. Then, through
   * {@link purgeTenantRecords}:
   *
   * - every model registered with `CorePersistenceModule.forFeature()` that has a `tenantId` path, on whatever
   *   database it is routed to — the project's own models included;
   * - models with a `tenantId` path registered only through `MongooseModule.forFeature()` (MongoDB);
   * - the core models that reference a tenant without a `tenantId` path: the AI budget limits, connection preferences,
   *   tool grants and tool policies (`scope: 'tenant'`, `refId`);
   * - AI connections: one only this tenant could use is deleted, from a shared one the tenant is removed. Never the
   *   other way round — an empty `tenantIds` list means "every tenant".
   *
   * Left out: models in `multiTenancy.excludeSchemas` (a `tenantId` there is no ownership), every model named in
   * `exclude`, users (they are global), and files — their bytes can only be assigned to a tenant by the project, which
   * deletes them through `CoreFileService`. The memberships cannot be excluded. A synchronized model keeps a tombstone
   * per deleted record until the tombstone purge removes it.
   */
  async purgeTenantData(tenantId: string, options: TenantPurgeOptions = {}): Promise<Record<string, number>> {
    requireTenantId(tenantId);
    const dryRun = options.dryRun === true;
    const exclude = new Set([
      ...(ConfigService.configFastButReadOnly?.multiTenancy?.excludeSchemas ?? []),
      ...(options.exclude ?? []),
    ]);
    exclude.delete(this.memberModel.modelName);

    // Access ends before the data goes
    const access = await this.endTenantAccess(tenantId, { dryRun, exclude });
    const records = await this.purgeTenantRecords(tenantId, { dryRun, exclude });

    return Object.fromEntries(Object.entries({ ...access, ...records }).filter(([, count]) => count > 0));
  }

  /**
   * End every way into a tenant (or with `dryRun` count it): the memberships, and the references that grant access on
   * their own — the tenant's API tokens, which need no member. Runs before {@link purgeTenantRecords}, or a member or an
   * integration with a tenant token writes into the tenant while its data goes
   */
  protected async endTenantAccess(
    tenantId: string,
    { dryRun, exclude }: { dryRun: boolean; exclude: ReadonlySet<string> },
  ): Promise<Record<string, number>> {
    const report: Record<string, number> = {
      [this.memberModel.modelName]: dryRun ? await this.countMembers(tenantId) : await this.deleteAllMembers(tenantId),
    };
    await RequestContext.runWithBypassTenantGuard(() =>
      this.purgeReferences(tenantId, { access: true, dryRun, exclude }, report),
    );
    return report;
  }

  /**
   * Delete (or with `dryRun` count) a tenant's records in every model except what {@link endTenantAccess} handles. The
   * place to add a project's own references: override it, call `super`, add the counts. Runs after the access is gone;
   * `exclude` already holds `multiTenancy.excludeSchemas`
   */
  protected async purgeTenantRecords(
    tenantId: string,
    { dryRun, exclude }: { dryRun: boolean; exclude: ReadonlySet<string> },
  ): Promise<Record<string, number>> {
    const report: Record<string, number> = {};
    await RequestContext.runWithBypassTenantGuard(async () => {
      const handled = new Set<string>([
        this.memberModel.modelName,
        AI_CONNECTION_MODEL,
        ...TENANT_REFERENCES.map((reference) => reference.model),
      ]);

      // Every routed model with a tenantId path
      for (const [name, descriptor] of getModelDescriptors()) {
        const store =
          descriptor.tenantScoped &&
          !handled.has(name) &&
          !exclude.has(name) &&
          getModelStore(this.mongoConnection, name);
        if (store) {
          handled.add(name);
          const where = { tenantId };
          report[name] = dryRun ? await store.count(where) : await this.deleteInBatches(store, where);
        }
      }

      // MongoDB models no store serves (registered only through MongooseModule.forFeature())
      for (const [name, model] of Object.entries(this.mongoConnection?.models ?? {})) {
        if (!handled.has(name) && !exclude.has(name) && model.schema?.path('tenantId')) {
          const where = { tenantId };
          report[name] = dryRun ? await model.countDocuments(where) : (await model.deleteMany(where)).deletedCount;
        }
      }

      // Core models that name the tenant in another field
      await this.purgeReferences(tenantId, { access: false, dryRun, exclude }, report);

      if (!exclude.has(AI_CONNECTION_MODEL)) {
        report[AI_CONNECTION_MODEL] = await this.purgeTenantConnections(tenantId, dryRun);
      }
    });
    return report;
  }

  /** The core references of {@link TENANT_REFERENCES} that do (`access`) or do not grant access, into `report` */
  private async purgeReferences(
    tenantId: string,
    { access, dryRun, exclude }: { access: boolean; dryRun: boolean; exclude: ReadonlySet<string> },
    report: Record<string, number>,
  ): Promise<void> {
    for (const reference of TENANT_REFERENCES) {
      const store =
        !!reference.access === access &&
        !exclude.has(reference.model) &&
        getModelStore(this.mongoConnection, reference.model);
      if (store) {
        const where = reference.where(tenantId);
        report[reference.model] = dryRun ? await store.count(where) : await this.deleteInBatches(store, where);
      }
    }
  }

  /**
   * Take a tenant out of the AI connections: delete a connection only this tenant could use, remove the tenant from
   * the list of a shared one. Never empty a list — an empty `tenantIds` means "every tenant", so that would hand the
   * connection, API key included, to all of them. Answers how many connections were touched
   */
  protected async purgeTenantConnections(tenantId: string, dryRun: boolean): Promise<number> {
    const store = getModelStore(this.mongoConnection, AI_CONNECTION_MODEL);
    if (!store) {
      return 0;
    }
    const connections = await store.find({ tenantIds: { $all: [tenantId] } });
    if (dryRun) {
      return connections.length;
    }
    for (const connection of connections) {
      const remaining = (connection.tenantIds ?? []).filter((id: string) => id !== tenantId);
      if (remaining.length === 0) {
        await store.deleteById(connection.id);
      } else {
        await store.updateById(connection.id, { tenantIds: remaining });
      }
    }
    return connections.length;
  }

  /**
   * Delete what `where` matches in batches of {@link TENANT_PURGE_BATCH} ids, as the tombstone purge does. One statement
   * over all of a tenant's rows of a synchronized SQL model holds the model's change lock until it commits, and every
   * other tenant's writes to that model wait for it. Answers how many records went
   */
  protected async deleteInBatches(store: DataStore<any>, where: Record<string, unknown>): Promise<number> {
    let deleted = 0;
    let after: string | undefined;
    for (;;) {
      const batch = await store.find(
        { ...where, ...(after ? { id: { $gt: after } } : {}) },
        { limit: TENANT_PURGE_BATCH, select: ['id'], sort: { id: 1 } },
      );
      if (!batch.length) {
        return deleted;
      }
      deleted += await store.deleteMany({ ...where, id: { $in: batch.map((record) => record.id) } });
      if (batch.length < TENANT_PURGE_BATCH) {
        return deleted;
      }
      after = batch[batch.length - 1].id;
    }
  }

  /**
   * The store serving the membership model on either database, or `undefined` for a model registered only through
   * `MongooseModule.forFeature()` — then the Mongoose model is used
   */
  protected memberDataStore(): DataStore<any> | undefined {
    return getStoreForModel(this.memberModel) ?? getModelStore(this.mongoConnection, this.memberModel.modelName);
  }

  /** How many memberships a tenant has, in any status */
  protected countMembers(tenantId: string): Promise<number> {
    const where = { tenant: tenantId };
    const store = this.memberDataStore();
    return RequestContext.runWithBypassTenantGuard(() =>
      store ? store.count(where) : this.memberModel.countDocuments(where).exec(),
    );
  }
}

/** Options of {@link CoreTenantService.purgeTenantData} */
export interface TenantPurgeOptions {
  /** Only count what would be deleted */
  dryRun?: boolean;
  /** Model names to leave alone, in addition to `multiTenancy.excludeSchemas`. The memberships always go */
  exclude?: string[];
}

/** Records `purgeTenantData()` deletes per statement */
const TENANT_PURGE_BATCH = 1000;

/**
 * Core models that reference a tenant without a `tenantId` path, and how they name it. `access`: the record lets
 * somebody into the tenant on its own, so it goes together with the memberships, before the data
 */
const TENANT_REFERENCES: ReadonlyArray<{
  access?: boolean;
  model: string;
  where: (tenantId: string) => Record<string, unknown>;
}> = [
  // A tenant token needs no membership
  { access: true, model: API_TOKEN_MODEL_TOKEN, where: (tenantId) => ({ tenant: tenantId }) },
  { model: AI_BUDGET_LIMIT_MODEL, where: (tenantId) => ({ refId: tenantId, scope: 'tenant' }) },
  { model: AI_CONNECTION_PREFERENCE_MODEL, where: (tenantId) => ({ refId: tenantId, scope: 'tenant' }) },
  { model: AI_TOOL_GRANT_MODEL, where: (tenantId) => ({ refId: tenantId, scope: 'tenant' }) },
  { model: AI_TOOL_POLICY_MODEL, where: (tenantId) => ({ refId: tenantId, scope: 'tenant' }) },
];

/**
 * Refuse a tenant id a delete must not run with. `deleteMany({ tenantId: undefined })` matches every document on
 * MongoDB, and an operator object (`{ $ne: null }`) would match every tenant
 */
function requireTenantId(tenantId: unknown): asserts tenantId is string {
  if (typeof tenantId !== 'string' || !tenantId.trim()) {
    throw new BadRequestException('tenantId must be a non-empty string');
  }
}

/**
 * Refuse a membership role that would cross the tenant boundary.
 *
 * Membership roles are customer-assigned free text, and whoever may manage members is typically a
 * tenant owner — a customer. Two families of name must never become one:
 *
 * - **system roles** (`s_*`) are runtime-context questions ("is this the owner of the record?"),
 *   not stored roles. A membership named `s_self` used to satisfy `@Restricted(S_SELF)` on
 *   arbitrary records.
 * - **global-only roles** (`RoleEnum.ADMIN`) are platform authority. A membership named `admin`
 *   used to satisfy `@Roles(RoleEnum.ADMIN)` — the global role — inside tenant context.
 *
 * This is the SECOND layer, not the protection itself. The guards resolve each required role
 * against its own source (`user.roles` vs `membership.role`), so an already-stored dangerous name
 * is inert even without this check — which matters, because a future `RoleEnum` addition would
 * otherwise turn every pre-existing membership of that name into a hole retroactively. This check
 * only stops new ones from being created, and gives a clear error instead of silent inertness.
 */
export function assertAssignableMembershipRole(role: string): void {
  if (looksLikeSystemRole(role)) {
    throw new BadRequestException(
      `A system role (${SYSTEM_ROLE_PREFIX}*) must never be used as a tenant membership role: ${role}`,
    );
  }
  if (looksLikeGlobalOnlyRole(role)) {
    throw new BadRequestException(
      `"${role}" is a global role and must never be used as a tenant membership role — ` +
        'use a tenant-specific name such as "tenantAdmin" instead',
    );
  }

  // Deny by default, when enabled: only roles the project actually declared.
  //
  // An undeclared role can never GRANT anything either way — the guards match only declared tenant
  // roles — so this does not change access decisions. What it changes is WHEN the mistake surfaces:
  // as a 400 at assignment time, instead of as a membership that silently authorizes nothing while
  // looking perfectly fine in a members list.
  const config = ConfigService.configFastButReadOnly?.multiTenancy;
  if (config?.strictMembershipRoles) {
    const declared = new Set([
      ...Object.keys(config.roleHierarchy ?? DEFAULT_ROLE_HIERARCHY),
      ...(config.additionalMembershipRoles ?? []),
    ]);
    if (!declared.has(role)) {
      throw new BadRequestException(
        `"${role}" is not a declared tenant role. Declared: [${[...declared].sort().join(', ')}]. ` +
          'Add it to multiTenancy.roleHierarchy or multiTenancy.additionalMembershipRoles, ' +
          'or disable multiTenancy.strictMembershipRoles.',
      );
    }
  }
}
