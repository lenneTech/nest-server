import { ObjectType } from '@nestjs/graphql';
import { Schema as MongooseSchema, Prop, SchemaFactory } from '@nestjs/mongoose';
import { IsEmail } from 'class-validator';
import { Document, Schema } from 'mongoose';

import { Restricted } from '../../../core/common/decorators/restricted.decorator';
import { Translatable } from '../../../core/common/decorators/translatable.decorator';
import { UnifiedField } from '../../../core/common/decorators/unified-field.decorator';
import { RoleEnum } from '../../../core/common/enums/role.enum';
import { CoreUserModel } from '../../../core/modules/user/core-user.model';
import { PersistenceModel } from '../../common/models/persistence.model';

export type UserDocument = Document & User;

/**
 * User model
 */
@MongooseSchema({ timestamps: true })
@ObjectType({ description: 'User' })
@Restricted(RoleEnum.ADMIN)
export class User extends CoreUserModel implements PersistenceModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * URL to avatar file of the user
   */
  @UnifiedField({
    description: 'URL to avatar file of the user',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.S_EVERYONE,
  })
  avatar: string = undefined;

  /**
   * ID of the user who created the object
   *
   * Not set when created by system
   */
  @UnifiedField({
    description: 'ID of the user who created the object',
    isOptional: true,
    mongoose: { ref: 'User', type: Schema.Types.ObjectId },
    roles: RoleEnum.S_EVERYONE,
    type: () => String,
  })
  createdBy: string = undefined;

  /**
   * E-Mail address of the user
   */
  @UnifiedField({
    description: 'Email of the user',
    isOptional: true,
    mongoose: { lowercase: true, trim: true, unique: true },
    roles: RoleEnum.S_EVERYONE,
    validator: () => [IsEmail()],
  })
  override email: string = undefined;

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
  override roles: string[] = undefined;

  @Translatable()
  @UnifiedField({
    description: 'Job title of user',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.S_EVERYONE,
  })
  jobTitle?: string = undefined;

  /**
   * ID of the user who updated the object
   *
   * Not set when updated by system
   */
  @UnifiedField({
    description: 'ID of the user who last updated the object',
    isOptional: true,
    mongoose: { ref: 'User', type: Schema.Types.ObjectId },
    roles: RoleEnum.S_USER,
    type: () => String,
  })
  updatedBy: string = undefined;

  @Prop({ default: {}, type: Schema.Types.Mixed })
  @Restricted(RoleEnum.S_EVERYONE)
  _translations?: Record<string, Partial<User>> = undefined;

  // ===================================================================================================================
  // Methods
  // ===================================================================================================================

  /**
   * Initialize instance with default values instead of undefined
   */
  override init() {
    super.init();
    // Nothing more to initialize yet
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

  /**
   * Verification of the user's rights to access the properties of this object
   */
  override securityCheck(user: User, force?: boolean) {
    if (force || (user && (user.id === this.id || user.hasRole(RoleEnum.ADMIN)))) {
      return this;
    }

    // Remove (values of) properties
    if (!user || user.id !== this.id) {
      this.roles = [];
      this.username = null;
      this.verified = null;
      this.verifiedAt = null;

      // PersistenceModel and CorePersistenceModel
      this.createdAt = null;
      this.createdBy = null;
      this.updatedAt = null;
      this.updatedBy = null;
    }

    // Return prepared user
    return this;
  }
}

export const UserSchema = SchemaFactory.createForClass(User);
