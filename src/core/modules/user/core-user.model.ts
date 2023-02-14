import { Field, ObjectType } from '@nestjs/graphql';
import { Prop, raw, Schema as MongooseSchema } from '@nestjs/mongoose';
import { IsEmail, IsOptional } from 'class-validator';
import { Document } from 'mongoose';
import { User } from '../../../server/modules/user/user.model';
import { CorePersistenceModel } from '../../common/models/core-persistence.model';

export type CoreUserModelDocument = CoreUserModel & Document;

/**
 * User model
 */
@ObjectType({ description: 'User', isAbstract: true })
@MongooseSchema({ timestamps: true })
export abstract class CoreUserModel extends CorePersistenceModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * E-Mail address of the user
   */
  @Field({ description: 'Email of the user', nullable: true })
  @IsEmail()
  @Prop({ unique: true })
  email: string = undefined;

  /**
   * First name of the user
   */
  @Field({ description: 'First name of the user', nullable: true })
  @IsOptional()
  @Prop()
  firstName: string = undefined;

  /**
   * Last name of the user
   */
  @Field({ description: 'Last name of the user', nullable: true })
  @IsOptional()
  @Prop()
  lastName: string = undefined;

  /**
   * Password of the user
   */
  @Prop()
  password: string = undefined;

  /**
   * Roles of the user
   */
  @Field((type) => [String], { description: 'Roles of the user', nullable: true })
  @IsOptional()
  @Prop()
  roles: string[] = undefined;

  /**
   * Username of the user
   */
  @Field({ description: 'Username of the user', nullable: true })
  @IsOptional()
  @Prop()
  username: string = undefined;

  /**
   * Password reset token of the user
   */
  @IsOptional()
  @Prop()
  passwordResetToken: string = undefined;

  /**
   * Hashed refresh JWT
   */
  @IsOptional()
  @Prop()
  refreshToken: string = undefined;

  /**
   * Refresh tokens for devices
   * key: deviceID
   * value: hashed JWT
   */
  @IsOptional()
  @Prop(raw({}))
  refreshTokens: Record<string, string> = undefined;

  /**
   * Verification token of the user
   */
  @IsOptional()
  @Prop()
  verificationToken: string = undefined;

  /**
   * Verification of the user
   */
  @Field((type) => Boolean, { description: 'Verification state of the user', nullable: true })
  @Prop({ type: Boolean })
  verified: boolean = undefined;

  /**
   * Verification date
   */
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
