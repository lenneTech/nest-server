import { ObjectType } from '@nestjs/graphql';
import { Schema } from '@nestjs/mongoose';
import { Types } from 'mongoose';

import { Restricted } from '../decorators/restricted.decorator';
import { UnifiedField } from '../decorators/unified-field.decorator';
import { RoleEnum } from '../enums/role.enum';
import { getStringIds } from '../helpers/db.helper';
import { CoreModel } from './core-model.model';

/**
 * Metadata for persistent objects
 *
 * The models are a combination of Mongoose Entities and TypeGraphQL Types
 *
 * HINT: All properties (in this class and all classes that extend this class) must be initialized with a default
 * value or undefined otherwise the property will not be recognized via Object.keys (this is necessary for mapping).
 * If the property is initialized with a default value (e.g. an empty array or boolean), there is a risk that the
 * current value will be overwritten during mapping without this being intentional, so all values should be initialized
 * with undefined if possible. If necessary and useful, the init method can then be used deliberately:
 * const corePersistenceModel = item ? CorePersistenceModel.map(item).init() : CorePersistenceModel.init();
 */
@ObjectType({
  description: 'Persistence model which will be saved in DB',
  isAbstract: true,
})
@Restricted(RoleEnum.S_EVERYONE)
@Schema({ timestamps: true })
export abstract class CorePersistenceModel extends CoreModel {
  // ===========================================================================
  // Getter
  // ===========================================================================

  @Restricted(RoleEnum.S_EVERYONE)
  get _id() {
    return new Types.ObjectId(this.id);
  }

  /**
   * Getter for created date as Unix timestamp
   */
  @UnifiedField({
    description: 'Created date (Unix timestamp)',
    isOptional: true,
    roles: RoleEnum.S_EVERYONE,
    swaggerApiOptions: { example: 1740037703939, format: 'int64', type: Number },
  })
  get createdTs(): number {
    if (this.createdAt instanceof Date) {
      return this.createdAt.getTime();
    }
    return this.createdAt;
  }

  /**
   * Getter for updated date as Unix timestamp
   */
  @UnifiedField({
    description: 'Updated date (Unix timestamp)',
    isOptional: true,
    roles: RoleEnum.S_EVERYONE,
    swaggerApiOptions: { example: 1740037703939, format: 'int64', type: Date },
  })
  get updatedTs(): number {
    if (this.updatedAt instanceof Date) {
      return this.updatedAt.getTime();
    }
    return this.updatedAt;
  }

  // ===========================================================================
  // Properties
  // ===========================================================================

  /**
   * ID of the persistence object as string
   */
  @UnifiedField({
    description: 'ID of the persistence object',
    isOptional: true,
    roles: RoleEnum.S_EVERYONE,
  })
  id: string = undefined;

  /**
   * Created date, is set automatically by mongoose
   */
  @UnifiedField({
    description: 'Created date',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.S_EVERYONE,
    swaggerApiOptions: { example: 1740037703939, format: 'int64', type: Date },
    type: Date,
  })
  createdAt: Date = undefined;

  /**
   * Updated date is set automatically by mongoose
   */
  @UnifiedField({
    description: 'Updated date',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.S_EVERYONE,
    swaggerApiOptions: { example: 1740037703939, format: 'int64', type: Date },
    type: Date,
  })
  updatedAt: Date = undefined;

  // ===========================================================================
  // Methods
  // ===========================================================================

  /**
   * Initialize instance with default values instead of undefined
   */
  override init() {
    super.init();
    this.createdAt = this.createdAt === undefined ? new Date() : this.createdAt;
    this.updatedAt = this.updatedAt === undefined ? this.createdAt : this.updatedAt;
    return this;
  }

  /**
   * Map input
   */
  override map(input) {
    super.map(input);
    if (input._id) {
      this.id = getStringIds(input);
    }
    return this;
  }
}
