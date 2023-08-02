import { Field, ObjectType } from '@nestjs/graphql';
import { Schema as MongooseSchema, Prop, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema } from 'mongoose';
import { RoleEnum } from '../../../core/common/enums/role.enum';
import { CoreUserModel } from '../../../core/modules/user/core-user.model';
import { PersistenceModel } from '../../common/models/persistence.model';

export type UserDocument = User & Document;

/**
 * User model
 */
@ObjectType({ description: 'User' })
@MongooseSchema({ timestamps: true })
export class User extends CoreUserModel implements PersistenceModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * URL to avatar file of the user
   */
  @Field({ description: 'URL to avatar file of the user', nullable: true })
  @Prop()
  avatar: string = undefined;

  /**
   * ID of the user who created the object
   *
   * Not set when created by system
   */
  @Field(() => String, {
    description: 'ID of the user who created the object',
    nullable: true,
  })
  @Prop({ type: Schema.Types.ObjectId, ref: 'User' })
  createdBy: string = undefined;

  /**
   * ID of the user who updated the object
   *
   * Not set when updated by system
   */
  @Field(() => String, {
    description: 'ID of the user who last updated the object',
    nullable: true,
  })
  @Prop({ type: Schema.Types.ObjectId, ref: 'User' })
  updatedBy: string = undefined;

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
      this.labels = null;
      this.tags = null;
      this.updatedAt = null;
      this.updatedBy = null;
    }

    // Return prepared user
    return this;
  }
}

export const UserSchema = SchemaFactory.createForClass(User);
