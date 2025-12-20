import { ObjectType } from '@nestjs/graphql';
import { Schema as MongooseSchema, Prop, raw } from '@nestjs/mongoose';
import { ApiExtraModels, ApiProperty } from '@nestjs/swagger';
import { Document } from 'mongoose';

import { Restricted } from '../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../common/decorators/unified-field.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { CorePersistenceModel } from '../../common/models/core-persistence.model';
import { CoreTokenData } from '../auth/interfaces/core-token-data.interface';

export type CoreUserModelDocument = CoreUserModel & Document;

/**
 * User model
 */
@ApiExtraModels(CorePersistenceModel)
@MongooseSchema({ timestamps: true })
@ObjectType({ description: 'User', isAbstract: true })
@Restricted(RoleEnum.S_EVERYONE)
export abstract class CoreUserModel extends CorePersistenceModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * E-Mail address of the user
   */
  @UnifiedField({
    description: 'Email of the user',
    isOptional: true,
    mongoose: { index: true, lowercase: true, trim: true },
    roles: RoleEnum.S_EVERYONE,
  })
  email: string = undefined;

  /**
   * First name of the user
   */
  @UnifiedField({
    description: 'First name of the user',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.S_EVERYONE,
  })
  firstName: string = undefined;

  /**
   * Last name of the user
   */
  @UnifiedField({
    description: 'Last name of the user',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.S_EVERYONE,
  })
  lastName: string = undefined;

  /**
   * Password of the user
   */
  @UnifiedField({
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.S_NO_ONE,
  })
  password: string = undefined;

  /**
   * Roles of the user
   */
  @UnifiedField({
    description: 'Roles of the user',
    isArray: true,
    isOptional: true,
    mongoose: [String],
    roles: RoleEnum.S_EVERYONE,
    type: () => String,
  })
  roles: string[] = undefined;

  /**
   * Username of the user
   */
  @UnifiedField({
    description: 'Username of the user',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.S_EVERYONE,
  })
  username: string = undefined;

  /**
   * Password reset token of the user
   */
  @UnifiedField({
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.S_NO_ONE,
  })
  passwordResetToken: string = undefined;

  /**
   * Refresh tokens (for devices)
   * key: Token
   * value: TokenData
   */
  @ApiProperty({ isArray: true })
  @ApiProperty({
    additionalProperties: {
      properties: {
        deviceDescription: {
          description: 'Description of the device from which the token was generated',
          nullable: true,
          type: 'string',
        },
        deviceId: {
          description: 'ID of the device from which the token was generated',
          nullable: true,
          type: 'string',
        },
        tokenId: {
          description: 'Token ID to make sure that there is only one RefreshToken for each device',
          nullable: false,
          type: 'string',
        },
      },
      type: 'object',
    },
    description: 'Refresh tokens for devices (key: Token, value: TokenData)',
    example: {
      '49b5c7d6-94ae-4efe-b377-9b50d1a9c2cb': {
        deviceDescription: null,
        deviceId: '49b5c7d6-94ae-4efe-b377-9b50d1a9c2cb',
        tokenId: '50937407-4282-480e-8679-14ecc113f9c7',
      },
      'e9e60a3e-2004-479f-8e79-13a0d1981d76': {
        deviceDescription: null,
        deviceId: 'e9e60a3e-2004-479f-8e79-13a0d1981d76',
        tokenId: '0604aa59-4fc8-4848-9fe7-c12d9cdf6ec0',
      },
    },
    type: 'object',
  })
  @Prop(raw({}))
  @Restricted(RoleEnum.S_NO_ONE)
  refreshTokens: Record<string, CoreTokenData> = undefined;

  /**
   * Temporary token for parallel requests during the token refresh process
   * See sameTokenIdPeriod in configuration
   */
  @ApiProperty()
  @ApiProperty({
    additionalProperties: {
      properties: {
        createdAt: {
          description: 'Token Created At',
          example: 1740037703939,
          format: 'int64',
          nullable: true,
          type: 'number',
        },
        deviceId: {
          description: 'ID of the device from which the token was generated',
          nullable: true,
          type: 'string',
        },
        tokenId: {
          description: 'Token ID to make sure that there is only one RefreshToken for each device',
          nullable: false,
          type: 'string',
        },
      },
      type: 'object',
    },
    description: 'Temporary token for parallel requests during the token refresh process',
    example: {
      // 👈 Add explicit example keys
      '49b5c7d6-94ae-4efe-b377-9b50d1a9c2cb': {
        createdAt: 1740037703939,
        deviceId: '49b5c7d6-94ae-4efe-b377-9b50d1a9c2cb',
        tokenId: '50937407-4282-480e-8679-14ecc113f9c7',
      },
      'f83ae5f6-90bf-4b4e-b318-651e0eaa67ae': {
        createdAt: 1740037703940,
        deviceId: 'f83ae5f6-90bf-4b4e-b318-651e0eaa67ae',
        tokenId: '4f0dc3c5-e74e-41f4-9bd9-642869462c1e',
      },
    },
    type: 'object',
  })
  @Prop(raw({}))
  @Restricted(RoleEnum.S_NO_ONE)
  tempTokens: Record<string, { createdAt: number; deviceId: string; tokenId: string }> = undefined;

  /**
   * Verification token of the user
   */
  @UnifiedField({
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.S_NO_ONE,
  })
  verificationToken: string = undefined;

  /**
   * Verification of the user
   */
  @UnifiedField({
    description: 'Verification state of the user',
    isOptional: true,
    mongoose: { type: Boolean },
    roles: RoleEnum.S_EVERYONE,
    type: () => Boolean,
  })
  verified: boolean = undefined;

  /**
   * Verification date
   */
  @UnifiedField({
    description: 'Verified date',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.S_EVERYONE,
  })
  verifiedAt: Date = undefined;

  // ===================================================================================================================
  // IAM Integration Fields (optional, used when Better-Auth or other IAM providers are enabled)
  // ===================================================================================================================

  /**
   * IAM (Identity and Access Management) provider user ID
   * Links this user to their identity in the IAM system (e.g., Better-Auth)
   */
  @UnifiedField({
    description: 'IAM provider user ID (used for Better-Auth or other IAM integration)',
    isOptional: true,
    mongoose: { index: true, sparse: true },
    roles: RoleEnum.S_NO_ONE,
  })
  iamId: string = undefined;

  /**
   * Whether 2FA is enabled for this user
   * Managed by Better-Auth's twoFactor plugin - read-only from our perspective
   */
  @UnifiedField({
    description: 'Whether Two-Factor Authentication is enabled',
    isOptional: true,
    mongoose: { type: Boolean },
    roles: RoleEnum.S_EVERYONE,
    type: () => Boolean,
  })
  twoFactorEnabled: boolean = undefined;

  // ===================================================================================================================
  // Methods
  // ===================================================================================================================

  /**
   * Checks whether the user has at least one of the required roles
   */
  public hasRole(roles: string | string[]) {
    if (typeof roles === 'string') {
      roles = [roles];
    }
    if (!this.roles || this.roles.length < 1) {
      return false;
    }
    return !roles || roles.length < 1 ? true : this.roles.some((role) => roles.includes(role));
  }

  /**
   * Checks whether the user has all required roles
   */
  public hasAllRoles(roles: string | string[]) {
    if (typeof roles === 'string') {
      roles = [roles];
    }
    if (!this.roles || this.roles.length < 1) {
      return false;
    }
    return !roles ? true : roles.every((role) => this.roles.includes(role));
  }

  /**
   * Initialize instance with default values instead of undefined
   */
  public override init() {
    super.init();
    this.roles = this.roles === undefined ? [] : this.roles;
    return this;
  }

  /**
   * Map input
   */
  override map(input) {
    super.map(input);
    // There is nothing to map yet. Non-primitive variables should always be mapped.
    // If something comes up, you can use `mapClasses` / `mapClassesAsync` from ModelHelper.
    return this;
  }
}
