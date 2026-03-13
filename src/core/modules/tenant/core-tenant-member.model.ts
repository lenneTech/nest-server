import { UnauthorizedException } from '@nestjs/common';
import { ObjectType } from '@nestjs/graphql';
import { Schema } from '@nestjs/mongoose';

import { UnifiedField } from '../../common/decorators/unified-field.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { CorePersistenceModel } from '../../common/models/core-persistence.model';
import { TenantMemberStatus, TenantRole } from './core-tenant.enums';

/**
 * Core tenant member model (join table: User <-> Tenant).
 *
 * Represents a user's membership in a tenant with a specific role and status.
 * This model is automatically excluded from tenant filtering (it is tenant-spanning).
 *
 * Projects can extend this model to add custom fields.
 */
@ObjectType({ description: 'Tenant membership', isAbstract: true })
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
   * Role within the tenant
   */
  @UnifiedField({
    description: 'Tenant role',
    mongoose: { default: TenantRole.MEMBER, enum: Object.values(TenantRole), type: String },
    roles: RoleEnum.S_USER,
    type: () => String,
  })
  role: TenantRole = undefined;

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
   */
  override securityCheck(user: any, force?: boolean): this {
    if (force || (user && (user.id === this.user || user.hasRole?.(RoleEnum.ADMIN)))) {
      return this;
    }

    throw new UnauthorizedException('Access to tenant membership denied');
  }
}
