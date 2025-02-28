import { Field, ObjectType } from '@nestjs/graphql';
import { Prop } from '@nestjs/mongoose';
import { ApiExtraModels, ApiProperty } from '@nestjs/swagger';
import { Types } from 'mongoose';

import { Restricted } from '../../../core/common/decorators/restricted.decorator';
import { RoleEnum } from '../../../core/common/enums/role.enum';
import { CorePersistenceModel } from '../../../core/common/models/core-persistence.model';
import { User } from '../../modules/user/user.model';

import mongoose = require('mongoose');

/**
 * Metadata for persistent objects
 *
 * The models are a combination of MikroORM Entities and TypeGraphQL Types
 */
@Restricted(RoleEnum.ADMIN)
@ObjectType({
  description: 'Persistence model which will be saved in DB',
  isAbstract: true,
})
@ApiExtraModels(CorePersistenceModel)
export abstract class PersistenceModel extends CorePersistenceModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * ID of the user who created the object
   *
   * Not set when created by system
   */
  @Restricted(RoleEnum.ADMIN)
  @Field(() => User, {
    description: 'ID of the user who created the object',
    nullable: true,
  })
  @Prop({ ref: 'User', type: mongoose.Schema.Types.ObjectId })
  @ApiProperty({ type: String })
  createdBy?: Types.ObjectId | string = undefined;

  /**
   * ID of the user who updated the object
   *
   * Not set when updated by system
   */
  @Restricted(RoleEnum.ADMIN)
  @Field(() => User, {
    description: 'ID of the user who updated the object',
    nullable: true,
  })
  @Prop({ ref: 'User', type: mongoose.Schema.Types.ObjectId })
  @ApiProperty({ type: User })
  updatedBy?: Types.ObjectId | string = undefined;

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
}
