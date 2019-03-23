import { Field, ID, ObjectType } from 'type-graphql';
import { User } from '../../modules/user/user.model';

/**
 * Metadata for persistent objects
 */
@ObjectType({description: 'Persistence model which will be saved in DB'})
export class PersistenceModel {

  // ===========================================================================
  // Properties
  //
  // Fields: https://typegraphql.ml/docs/types-and-fields.html
  // ===========================================================================

  /**
   * ID of the persistence object
   */
  @Field(type => ID, {description: 'ID of the persistence object'})
  id: string;

  /**
   * Created date
   */
  @Field({description: 'Created date'})
  createdAt: Date;

  /**
   * User who created the object
   *
   * Not set when created by system
   */
  @Field(type => User, {description: 'User who created the object', nullable: true })
  createdBy?: User;

  /**
   * Updated date
   */
  @Field({description: 'Updated date'})
  updatedAt: Date;

  /**
   * User who last updated the object
   *
   * Not set when updated by system
   */
  @Field(type => User, {description: 'User who last updated the object', nullable: true })
  updatedBy?: User;

}
