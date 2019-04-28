import { Field, ObjectType } from 'type-graphql';
import { JoinColumn, OneToOne } from 'typeorm';
import { Entity } from 'typeorm/decorator/entity/Entity';
import { IAuthUser } from '../../../core/modules/auth/interfaces/auth-user.interface';
import { User as CoreUser } from '../../../core/modules/user/user.model';

/**
 * Metadata for persistent objects
 *
 * The models are a combination of TypeORM Entities and TypeGraphQL Types
 */
@ObjectType({ description: 'User' })
@Entity()
export class User extends CoreUser {

  /**
   * User who created the object
   *
   * Not set when created by system
   */
  @Field(type => User, { description: 'User who created the object' })
  @OneToOne(type => User)
  @JoinColumn()
  createdBy: IAuthUser;

  /**
   * User who last updated the object
   *
   * Not set when updated by system
   */
  @Field(type => User, { description: 'User who last updated the object' })
  @OneToOne(type => User)
  @JoinColumn()
  updatedBy: IAuthUser;
}
