import { Field, ID, ObjectType } from 'type-graphql';
import { BeforeInsert, BeforeUpdate, Column, JoinColumn, ObjectIdColumn, OneToOne } from 'typeorm';
import { User } from '../../modules/user/user.model';

/**
 * Metadata for persistent objects
 *
 * The models are a combination of TypeORM Entities and TypeGraphQL Types
 */
@ObjectType({
  description: 'Persistence model which will be saved in DB',
  isAbstract: true,
})
export abstract class PersistenceClass {

  // ===========================================================================
  // Properties
  //
  // Fields: https://typegraphql.ml/docs/types-and-fields.html
  // ===========================================================================

  /**
   * ID of the persistence object
   */
  @Field(type => ID, { description: 'ID of the persistence object', nullable: true })
  @ObjectIdColumn()
  id: string;

  /**
   * Created date
   */
  @Field({ description: 'Created date', nullable: true })
  @Column()
  createdAt: Date;

  /**
   * User who created the object
   *
   * Not set when created by system
   */
  @Field(type => User, { description: 'User who created the object', nullable: true })
  @OneToOne(type => User)
  @JoinColumn()
  createdBy?: User;

  /**
   * Updated date
   */
  @Field({ description: 'Updated date', nullable: true })
  @Column()
  updatedAt: Date;

  /**
   * User who last updated the object
   *
   * Not set when updated by system
   */
  @Field(type => User, { description: 'User who last updated the object', nullable: true })
  @OneToOne(type => User)
  @JoinColumn()
  updatedBy?: User;

  // ===========================================================================
  // TypeORM Entity Listeners
  //
  // https://typeorm.io/#/listeners-and-subscribers
  // ===========================================================================

  /**
   * Manipulation before insert a new entity
   */
  @BeforeInsert()
  beforeInsert() {
    this.createdAt = this.updatedAt = new Date();
  }

  /**
   * Manipulation before update an existing entity
   */
  @BeforeUpdate()
  beforeUpdate() {
    this.updatedAt = new Date();
  }
}
