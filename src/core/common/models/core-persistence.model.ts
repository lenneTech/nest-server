import { Field, ID, ObjectType } from '@nestjs/graphql';
import { Prop, Schema } from '@nestjs/mongoose';
import { Types } from 'mongoose';

import { Restricted } from '../decorators/restricted.decorator';
import { RoleEnum } from '../enums/role.enum';
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
@Restricted(RoleEnum.S_EVERYONE)
@ObjectType({
  description: 'Persistence model which will be saved in DB',
  isAbstract: true,
})
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
  @Restricted(RoleEnum.S_EVERYONE)
  @Field(type => ID, {
    description: 'ID of the persistence object',
    nullable: true,
  })
  id: string = undefined;

  /**
   * Created date, is set automatically by mongoose
   */
  @Restricted(RoleEnum.S_EVERYONE)
  @Field({ description: 'Created date', nullable: true })
  @Prop({ onCreate: () => new Date() })
  createdAt: Date = undefined;

  /**
   * Labels of the object
   */
  @Restricted(RoleEnum.S_EVERYONE)
  @Field(type => [String], {
    description: 'Labels of the object',
    nullable: true,
  })
  @Prop([String])
  labels: string[] = undefined;

  /**
   * Tags for the object
   */
  @Restricted(RoleEnum.S_EVERYONE)
  @Field(type => [String], {
    description: 'Tags for the object',
    nullable: true,
  })
  @Prop([String])
  tags: string[] = undefined;

  /**
   * Updated date is set automatically by mongoose
   */
  @Restricted(RoleEnum.S_EVERYONE)
  @Field({ description: 'Updated date', nullable: true })
  @Prop({ onUpdate: () => new Date() })
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
    this.labels = this.labels === undefined ? [] : this.labels;
    this.tags = this.tags === undefined ? [] : this.tags;
    this.updatedAt = this.tags === undefined ? this.createdAt : this.updatedAt;
    return this;
  }
}
