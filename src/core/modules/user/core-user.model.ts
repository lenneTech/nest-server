import { Field, ObjectType } from '@nestjs/graphql';
import { Schema as MongooseSchema, Prop, raw } from '@nestjs/mongoose';
import { IsOptional } from 'class-validator';
import { Document } from 'mongoose';

import { Restricted } from '../../common/decorators/restricted.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { CorePersistenceModel } from '../../common/models/core-persistence.model';
import { CoreTokenData } from '../auth/interfaces/core-token-data.interface';

export type CoreUserModelDocument = CoreUserModel & Document;

/**
 * User model
 */
@Restricted(RoleEnum.S_EVERYONE)
@ObjectType({ description: 'User', isAbstract: true })
@MongooseSchema({ timestamps: true })
export abstract class CoreUserModel extends CorePersistenceModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * E-Mail address of the user
   */
  @Restricted(RoleEnum.S_EVERYONE)
  @Field({ description: 'Email of the user', nullable: true })
  @Prop({ index: true, lowercase: true, trim: true })
  email: string = undefined;

  /**
   * First name of the user
   */
  @Restricted(RoleEnum.S_EVERYONE)
  @Field({ description: 'First name of the user', nullable: true })
  @IsOptional()
  @Prop()
  firstName: string = undefined;

  /**
   * Last name of the user
   */
  @Restricted(RoleEnum.S_EVERYONE)
  @Field({ description: 'Last name of the user', nullable: true })
  @IsOptional()
  @Prop()
  lastName: string = undefined;

  /**
   * Password of the user
   */
  @Restricted(RoleEnum.S_NO_ONE)
  @Prop()
  password: string = undefined;

  /**
   * Roles of the user
   */
  @Restricted(RoleEnum.S_EVERYONE)
  @Field(type => [String], { description: 'Roles of the user', nullable: true })
  @IsOptional()
  @Prop([String])
  roles: string[] = undefined;

  /**
   * Username of the user
   */
  @Restricted(RoleEnum.S_EVERYONE)
  @Field({ description: 'Username of the user', nullable: true })
  @IsOptional()
  @Prop()
  username: string = undefined;

  /**
   * Password reset token of the user
   */
  @Restricted(RoleEnum.S_NO_ONE)
  @IsOptional()
  @Prop()
  passwordResetToken: string = undefined;

  /**
   * Refresh tokens (for devices)
   * key: Token
   * value: TokenData
   */
  @Restricted(RoleEnum.S_NO_ONE)
  @IsOptional()
  @Prop(raw({}))
  refreshTokens: Record<string, CoreTokenData> = undefined;

  /**
   * Temporary token for parallel requests during the token refresh process
   * See sameTokenIdPeriod in configuration
   */
  @Restricted(RoleEnum.S_NO_ONE)
  @IsOptional()
  @Prop(raw({}))
  tempTokens: Record<string, { createdAt: number; deviceId: string; tokenId: string }> = undefined;

  /**
   * Verification token of the user
   */
  @Restricted(RoleEnum.S_NO_ONE)
  @IsOptional()
  @Prop()
  verificationToken: string = undefined;

  /**
   * Verification of the user
   */
  @Restricted(RoleEnum.S_EVERYONE)
  @Field(type => Boolean, { description: 'Verification state of the user', nullable: true })
  @Prop({ type: Boolean })
  verified: boolean = undefined;

  /**
   * Verification date
   */
  @Restricted(RoleEnum.S_EVERYONE)
  @Field({ description: 'Verified date', nullable: true })
  @Prop()
  verifiedAt: Date = undefined;

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
    return !roles || roles.length < 1 ? true : this.roles.some(role => roles.includes(role));
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
    return !roles ? true : roles.every(role => this.roles.includes(role));
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
