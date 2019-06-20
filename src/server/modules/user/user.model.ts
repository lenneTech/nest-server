import { Field, ObjectType } from 'type-graphql';
import { Column, Entity, JoinColumn, OneToOne } from 'typeorm';
import { CoreUser } from '../../../core/modules/user/core-user.model';
import { PersistenceModel } from '../../common/models/persistence.model';

/**
 * User model
 */
@Entity()
@ObjectType({ description: 'User' })
export class User extends CoreUser implements PersistenceModel {

  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * URL to avatar file of the user
   */
  @Field({ description: 'URL to avatar file of the user', nullable: true })
  @Column()
  avatar: string;

  /**
   * User who created the object
   *
   * Not set when created by system
   */
  @Field(type => User, { description: 'User who created the object', nullable: true })
  @OneToOne(type => User)
  @JoinColumn()
  createdBy: User;

  /**
   * Labels of the object
   */
  @Field(type => [String], { description: 'Labels of the object', nullable: true })
  @Column()
  labels: string[] = [];

  /**
   * Tags for the object
   */
  @Field(type => [String], { description: 'Tags for the object', nullable: true })
  @Column()
  tags: string[] = [];

  /**
   * User who last updated the object
   *
   * Not set when updated by system
   */
  @Field(type => User, { description: 'User who last updated the object', nullable: true })
  @OneToOne(type => User)
  @JoinColumn()
  updatedBy: User;
}
