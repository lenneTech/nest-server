import { Entity, ManyToOne, Property } from '@mikro-orm/core';
import { Field, ObjectType } from '@nestjs/graphql';
import { CoreUserModel } from '../../../core/modules/user/core-user.model';
import { PersistenceModel } from '../../common/models/persistence.model';

/**
 * User model
 */
@Entity()
@ObjectType({ description: 'User' })
export class User extends CoreUserModel implements PersistenceModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * URL to avatar file of the user
   */
  @Field({ description: 'URL to avatar file of the user', nullable: true })
  @Property()
  avatar: string = undefined;

  /**
   * Editor who created the object
   *
   * Not set when created by system
   */
  @Field((type) => User, {
    description: 'ID of the user who created the object',
    nullable: true,
  })
  @ManyToOne()
  createdBy: User = undefined;

  /**
   * Editor who last updated the object
   *
   * Not set when updated by system
   */
  @Field((type) => User, {
    description: 'ID of the user who last updated the object',
    nullable: true,
  })
  @ManyToOne()
  updatedBy: User = undefined;
}
