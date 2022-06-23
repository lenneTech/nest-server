import { Types } from 'mongoose';
import * as mongoose from 'mongoose';
import { Prop } from '@nestjs/mongoose';
import { Field, ObjectType } from '@nestjs/graphql';
import { CorePersistenceModel } from '../../../core/common/models/core-persistence.model';
import { User } from '../../modules/user/user.model';

/**
 * Metadata for persistent objects
 *
 * The models are a combination of MikroORM Entities and TypeGraphQL Types
 */
@ObjectType({
  description: 'Persistence model which will be saved in DB',
  isAbstract: true,
})
export abstract class PersistenceModel extends CorePersistenceModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * ID of the user who created the object
   *
   * Not set when created by system
   */
  @Field(() => User, {
    description: 'ID of the user who created the object',
    nullable: true,
  })
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User' })
  createdBy?: Types.ObjectId | string = undefined;

  /**
   * ID of the user who updated the object
   *
   * Not set when updated by system
   */
  @Field(() => User, {
    description: 'ID of the user who updated the object',
    nullable: true,
  })
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User' })
  updatedBy?: Types.ObjectId | string = undefined;

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
    // There is nothing to map yet. Non-primitive variables should always be mapped.
    // If something comes up, you can use `mapClasses` / `mapClassesAsync` from ModelHelper.
    return this;
  }
}
