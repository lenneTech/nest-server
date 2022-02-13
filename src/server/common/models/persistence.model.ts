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
  /**
   * User who created the object
   *
   * Not set when created by system
   */
  @Field((type) => User, {
    description: 'User who created the object',
    nullable: true,
  })
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User' })
  createdBy?: Types.ObjectId | User = undefined;

  /**
   * User who last updated the object
   *
   * Not set when updated by system
   */
  @Field((type) => User, {
    description: 'User who last updated the object',
    nullable: true,
  })
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User' })
  updatedBy?: Types.ObjectId | User = undefined;

  // ===========================================================================
  // Properties
  // ===========================================================================

  /**
   * Initialize instance with default values instead of undefined
   */
  init() {
    super.init();
    // Nothing more to initialize yet
    return this;
  }
}
