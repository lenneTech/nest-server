import { Field, ID, ObjectType } from '@nestjs/graphql';
import { Prop, Schema } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { CoreModel } from './core-model.model';

/**
 * Metadata for persistent objects
 *
 * The models are a combination of Mongoose Entities and TypeGraphQL Types
 *
 * HINT: All properties (in this class and all classes that extend this class) must be initialized with undefined,
 * otherwise the property will not be recognized via Object.keys (this is necessary for mapping) or will be initialized
 * with a default value that may overwrite an existing value in the DB.
 */
@ObjectType({
  description: 'Persistence model which will be saved in DB',
  isAbstract: true,
})
@Schema({ timestamps: true })
export abstract class CorePersistenceModel extends CoreModel {
  // ===========================================================================
  // Getter
  // ===========================================================================

  get _id() {
    return new Types.ObjectId(this.id);
  }

  // ===========================================================================
  // Properties
  // ===========================================================================

  /**
   * ID of the persistence object as string
   */
  @Field((type) => ID, {
    description: 'ID of the persistence object',
    nullable: true,
  })
  id: string = undefined;

  /**
   * Created date, is set automatically by mongoose
   */
  @Field({ description: 'Created date', nullable: true })
  @Prop({ onCreate: () => new Date() })
  createdAt: Date = undefined;

  /**
   * Labels of the object
   */
  @Field((type) => [String], {
    description: 'Labels of the object',
    nullable: true,
  })
  @Prop([String])
  labels: string[] = undefined;

  /**
   * IDs of the Owners
   */
  @Field((type) => [String], {
    description: 'Users who own the object',
    nullable: true,
  })
  @Prop([String])
  ownerIds: string[] = undefined;

  /**
   * Tags for the object
   */
  @Field((type) => [String], {
    description: 'Tags for the object',
    nullable: true,
  })
  @Prop([String])
  tags: string[] = undefined;

  /**
   * Updated date is set automatically by mongoose
   */
  @Field({ description: 'Updated date', nullable: true })
  @Prop({ onUpdate: () => new Date() })
  updatedAt: Date = undefined;
}
