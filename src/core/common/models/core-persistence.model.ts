import { Field, ID, ObjectType } from '@nestjs/graphql';
import { Prop, Schema } from '@nestjs/mongoose';
import { ApiProperty } from '@nestjs/swagger';
import { Types } from 'mongoose';

import { Restricted } from '../decorators/restricted.decorator';
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

  // ===========================================================================
  // Properties
  // ===========================================================================

  /**
   * ID of the persistence object as string
   */
  @ApiProperty({ type: String })
  @Field(() => ID, {
    description: 'ID of the persistence object',
    nullable: true,
  })
  @Restricted(RoleEnum.S_EVERYONE)
  id: string = undefined;

  /**
   * Created date, is set automatically by mongoose
   */
  @ApiProperty({ example: 1740037703939, format: 'int64', type: Date })
  @Field({ description: 'Created date', nullable: true })
  @Prop({ onCreate: () => new Date() })
  @Restricted(RoleEnum.S_EVERYONE)
  createdAt: Date = undefined;

  /**
   * Updated date is set automatically by mongoose
   */
  @ApiProperty({ example: 1740037703939, format: 'int64', type: String })
  @Field({ description: 'Updated date', nullable: true })
  @Prop({ onUpdate: () => new Date() })
  @Restricted(RoleEnum.S_EVERYONE)
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
