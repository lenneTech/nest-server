import { Field, ObjectType } from '@nestjs/graphql';
import { Prop, Schema as MongooseSchema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema, Types } from 'mongoose';
import { mapClasses } from '../../../core/common/helpers/model.helper';
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
  createdBy: Types.ObjectId | string = undefined;

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
  updatedBy: Types.ObjectId | string = undefined;

  // ===================================================================================================================
  // Methods
  // ===================================================================================================================

  /**
   * Initialize instance with default values instead of undefined
   */
  init() {
    super.init();
    // Nothing more to initialize yet
    return this;
  }

  /**
   * Map input
   */
  map(input) {
    super.map(input);
    return mapClasses(input, { createdBy: User, updatedBy: User }, this);
  }
}

export const UserSchema = SchemaFactory.createForClass(User);
