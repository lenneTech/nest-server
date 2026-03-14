import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { ConfigService } from '../../common/services/config.service';
import { RequestContext } from '../../common/services/request-context.service';
import { CoreTenantMemberModel } from './core-tenant-member.model';
import { DEFAULT_ROLE_HIERARCHY, TENANT_MEMBER_MODEL_TOKEN, TenantMemberStatus } from './core-tenant.enums';

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

  constructor(@InjectModel(TENANT_MEMBER_MODEL_TOKEN) protected readonly memberModel: Model<CoreTenantMemberModel>) {}

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
   * Get a single membership (any status).
   */
  async getMembership(tenantId: string, userId: string): Promise<CoreTenantMemberModel | null> {
    return this.memberModel
      .findOne({ tenant: tenantId, user: userId })
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

    // Check for existing membership
    const existing = await this.getMembership(tenantId, userId);
    if (existing) {
      if (existing.status === TenantMemberStatus.ACTIVE) {
        throw new BadRequestException('User is already an active member of this tenant');
      }
      // Reactivate suspended/invited membership
      return RequestContext.runWithBypassTenantGuard(async () => {
        return this.memberModel
          .findOneAndUpdate(
            { tenant: tenantId, user: userId },
            {
              invitedBy: invitedById,
              joinedAt: new Date(),
              role: effectiveRole,
              status: TenantMemberStatus.ACTIVE,
            },
            { new: true },
          )
          .lean()
          .exec() as Promise<CoreTenantMemberModel>;
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
          { new: true },
        )
        .lean()
        .exec();

      if (!result) {
        throw new NotFoundException('Membership not found');
      }

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
    const highestRole = this.getHighestRole();

    // If demoting from highest role, ensure it's not the last one
    const existing = await this.getMembership(tenantId, userId);
    if (existing?.role === highestRole && role !== highestRole) {
      await this.assertNotLastOwner(tenantId, userId);
    }

    return RequestContext.runWithBypassTenantGuard(async () => {
      const result = await this.memberModel
        .findOneAndUpdate(
          { status: TenantMemberStatus.ACTIVE, tenant: tenantId, user: userId },
          { role },
          { new: true },
        )
        .lean()
        .exec();

      if (!result) {
        throw new NotFoundException('Active membership not found');
      }

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
        const membership = await this.getMembership(tenantId, userId);
        if (membership?.role === highestRole) {
          throw new BadRequestException('Cannot remove or demote the last owner of a tenant');
        }
      }
    });
  }
}
