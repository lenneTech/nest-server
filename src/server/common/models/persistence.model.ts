import { ObjectType } from '@nestjs/graphql';
import { ApiExtraModels } from '@nestjs/swagger';
import { Types } from 'mongoose';
import mongoose = require('mongoose');

import { Restricted } from '../../../core/common/decorators/restricted.decorator';
import { UnifiedField } from '../../../core/common/decorators/unified-field.decorator';
import { RoleEnum } from '../../../core/common/enums/role.enum';
import { CorePersistenceModel } from '../../../core/common/models/core-persistence.model';
import { User } from '../../modules/user/user.model';

/**
 * Metadata for persistent objects
 *
 * The models are a combination of MikroORM Entities and TypeGraphQL Types
 */
@ApiExtraModels(CorePersistenceModel)
@ObjectType({
  description: 'Persistence model which will be saved in DB',
  isAbstract: true,
})
@Restricted(RoleEnum.ADMIN)
export abstract class PersistenceModel extends CorePersistenceModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * ID of the user who created the object
   *
   * Not set when created by system
   */
  @UnifiedField({
    description: 'ID of the user who created the object',
    isOptional: true,
    mongoose: { ref: 'User', type: mongoose.Schema.Types.ObjectId },
    roles: RoleEnum.ADMIN,
    swaggerApiOptions: { type: String },
    type: () => User,
  })
  createdBy?: string | Types.ObjectId = undefined;

  /**
   * ID of the user who updated the object
   *
   * Not set when updated by system
   */
  @UnifiedField({
    description: 'ID of the user who updated the object',
    isOptional: true,
    mongoose: { ref: 'User', type: mongoose.Schema.Types.ObjectId },
    roles: RoleEnum.ADMIN,
    swaggerApiOptions: { type: User },
    type: () => User,
  })
  updatedBy?: string | Types.ObjectId = undefined;

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
