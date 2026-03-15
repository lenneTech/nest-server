import { UnauthorizedException } from '@nestjs/common';
import { ObjectType } from '@nestjs/graphql';
import { Schema } from '@nestjs/mongoose';

import { Restricted } from '../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../common/decorators/unified-field.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { CorePersistenceModel } from '../../common/models/core-persistence.model';
import { RequestContext } from '../../common/services/request-context.service';
import { DefaultHR, TenantMemberStatus } from './core-tenant.enums';
import { checkRoleAccess } from './core-tenant.helpers';

/**
 * Core tenant member model (join table: User <-> Tenant).
 *
 * Represents a user's membership in a tenant with a specific role and status.
 * This model is automatically excluded from tenant filtering (it is tenant-spanning).
 *
 * Projects can extend this model to add custom fields.
 */
@ObjectType({ description: 'Tenant membership', isAbstract: true })
@Restricted(RoleEnum.S_USER)
@Schema({ timestamps: true })
export class CoreTenantMemberModel extends CorePersistenceModel {
  /**
   * ID of the user who invited this member
   */
  @UnifiedField({
    description: 'ID of the inviting user',
    isOptional: true,
    mongoose: { type: String },
    roles: RoleEnum.S_USER,
  })
  invitedBy: string = undefined;

  /**
   * Date when the user joined the tenant
   */
  @UnifiedField({
    description: 'Date when the user joined',
    isOptional: true,
    mongoose: { type: Date },
    roles: RoleEnum.S_USER,
    type: Date,
  })
  joinedAt: Date = undefined;

  /**
   * Role within the tenant (string matching a key in the configured role hierarchy)
   */
  @UnifiedField({
    description: 'Tenant role',
    mongoose: { default: 'member', type: String },
    roles: RoleEnum.S_USER,
    type: () => String,
  })
  role: string = undefined;

  /**
   * Membership status
   */
  @UnifiedField({
    description: 'Membership status',
    mongoose: { default: TenantMemberStatus.ACTIVE, enum: Object.values(TenantMemberStatus), type: String },
    roles: RoleEnum.S_USER,
    type: () => String,
  })
  status: TenantMemberStatus = undefined;

  /**
   * Tenant ID (= tenantId for data isolation)
   */
  @UnifiedField({
    description: 'Tenant ID',
    mongoose: { index: true, type: String },
    roles: RoleEnum.S_USER,
  })
  tenant: string = undefined;

  /**
   * User ID (reference to User collection)
   */
  @UnifiedField({
    description: 'User ID',
    mongoose: { index: true, type: String },
    roles: RoleEnum.S_USER,
  })
  user: string = undefined;

  /**
   * Verification of the user's rights to access the properties of this object.
   *
   * Allows access when:
   * - force mode is enabled
   * - the requesting user owns this membership (user.id === this.user)
   * - the requesting user is a system admin
   * - the requesting user is at least a manager-level member of the same tenant
   */
  override securityCheck(user: any, force?: boolean): this {
    if (force) return this;
    if (!user) throw new UnauthorizedException('Access to tenant membership denied');

    // Own membership or system admin
    if (user.id === this.user || user.hasRole?.(RoleEnum.ADMIN)) return this;

    // Tenant manager/owner of the same tenant can view members.
    // context.tenantId is the guard-validated tenant ID (not the raw header),
    // see RequestContextMiddleware which reads req.tenantId.
    const context = RequestContext.get();
    const tenantRole = context?.tenantRole;
    if (
      tenantRole &&
      checkRoleAccess([DefaultHR.MANAGER], undefined, tenantRole) &&
      context?.tenantId === this.tenant
    ) {
      return this;
    }

    throw new UnauthorizedException('Access to tenant membership denied');
  }
}
