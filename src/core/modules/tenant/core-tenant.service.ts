import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { RequestContext } from '../../common/services/request-context.service';
import { CoreTenantMemberModel } from './core-tenant-member.model';
import { TenantMemberStatus, TenantRole } from './core-tenant.enums';

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
 *   override async addMember(tenantId: string, userId: string, role: TenantRole) {
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

  constructor(@InjectModel('TenantMember') protected readonly memberModel: Model<CoreTenantMemberModel>) {}

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
   */
  async addMember(
    tenantId: string,
    userId: string,
    role: TenantRole = TenantRole.MEMBER,
    invitedById?: string,
  ): Promise<CoreTenantMemberModel> {
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
              role,
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
        role,
        status: TenantMemberStatus.ACTIVE,
        tenant: tenantId,
        user: userId,
      });
      return doc.toObject() as CoreTenantMemberModel;
    });
  }

  /**
   * Remove a member from a tenant (sets status to SUSPENDED).
   * Prevents removing the last OWNER.
   */
  async removeMember(tenantId: string, userId: string): Promise<CoreTenantMemberModel> {
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
   * Prevents demoting the last OWNER.
   */
  async updateMemberRole(tenantId: string, userId: string, role: TenantRole): Promise<CoreTenantMemberModel> {
    // If demoting from OWNER, ensure it's not the last one
    const existing = await this.getMembership(tenantId, userId);
    if (existing?.role === TenantRole.OWNER && role !== TenantRole.OWNER) {
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
   * Ensure the given user is not the last OWNER of the tenant.
   * Throws BadRequestException if removing/demoting them would leave the tenant without an owner.
   *
   * Note: This uses a read-check-act pattern which has a theoretical TOCTOU race under
   * concurrent requests. For production environments with high concurrency, consider using
   * MongoDB transactions (requires replica set) in your extended service.
   */
  async assertNotLastOwner(tenantId: string, userId: string): Promise<void> {
    return RequestContext.runWithBypassTenantGuard(async () => {
      const ownerCount = await this.memberModel.countDocuments({
        role: TenantRole.OWNER,
        status: TenantMemberStatus.ACTIVE,
        tenant: tenantId,
      });

      if (ownerCount <= 1) {
        const membership = await this.getMembership(tenantId, userId);
        if (membership?.role === TenantRole.OWNER) {
          throw new BadRequestException('Cannot remove or demote the last owner of a tenant');
        }
      }
    });
  }
}
