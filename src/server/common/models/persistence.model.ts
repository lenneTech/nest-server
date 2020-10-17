import { ManyToOne, Property } from '@mikro-orm/core';
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
  @ManyToOne()
  createdBy?: User = undefined;

  /**
   * User who last updated the object
   *
   * Not set when updated by system
   */
  @Field((type) => User, {
    description: 'User who last updated the object',
    nullable: true,
  })
  @Property()
  updatedBy?: User = undefined;
}
