import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { looksLikeGlobalOnlyRole, looksLikeSystemRole, SYSTEM_ROLE_PREFIX } from '../../common/enums/role.enum';
import { ConfigService } from '../../common/services/config.service';
import { RequestContext } from '../../common/services/request-context.service';
import { CoreTenantMemberModel } from './core-tenant-member.model';
import { DEFAULT_ROLE_HIERARCHY, TENANT_MEMBER_MODEL_TOKEN, TenantMemberStatus } from './core-tenant.enums';
import { CoreTenantGuard } from './core-tenant.guard';

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

  constructor(
    @InjectModel(TENANT_MEMBER_MODEL_TOKEN) protected readonly memberModel: Model<CoreTenantMemberModel>,
    @Optional() protected readonly tenantGuard?: CoreTenantGuard,
  ) {}

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

    return this.memberModel
      .findOne({ status: TenantMemberStatus.ACTIVE, tenant: tenantId, user: userId })
      .lean()
      .exec() as Promise<CoreTenantMemberModel | null>;
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
        const result = (await this.memberModel
          .findOneAndUpdate(
            { tenant: tenantId, user: userId },
            {
              invitedBy: invitedById,
              joinedAt: new Date(),
              role: effectiveRole,
              status: TenantMemberStatus.ACTIVE,
            },
            { returnDocument: 'after' },
          )
          .lean()
          .exec()) as CoreTenantMemberModel;
        this.tenantGuard?.invalidateUser(userId);
        return result;
      });
    }

    return RequestContext.runWithBypassTenantGuard(async () => {
      const doc = await this.memberModel.create({
        invitedBy: invitedById,
        joinedAt: new Date(),
        role: effectiveRole,
        status: TenantMemberStatus.ACTIVE,
        tenant: tenantId,
        user: userId,
      });
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
      const result = await this.memberModel
        .findOneAndUpdate(
          { status: TenantMemberStatus.ACTIVE, tenant: tenantId, user: userId },
          { status: TenantMemberStatus.SUSPENDED },
          { returnDocument: 'after' },
        )
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
      const result = await this.memberModel
        .findOneAndUpdate(
          { status: TenantMemberStatus.ACTIVE, tenant: tenantId, user: userId },
          { role },
          { returnDocument: 'after' },
        )
        .lean()
        .exec();

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
      const ownerCount = await this.memberModel.countDocuments({
        role: highestRole,
        status: TenantMemberStatus.ACTIVE,
        tenant: tenantId,
      });

      if (ownerCount <= 1) {
        const membership = await this.getActiveMembership(tenantId, userId);
        if (membership?.role === highestRole) {
          throw new BadRequestException('Cannot remove or demote the last owner of a tenant');
        }
      }
    });
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
