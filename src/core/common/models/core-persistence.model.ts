import { Field, ID, ObjectType } from 'type-graphql';
import { BeforeInsert, BeforeUpdate, Column, ObjectIdColumn } from 'typeorm';
import { Restricted } from '../decorators/restricted.decorator';
import { RoleEnum } from '../enums/role.enum';

/**
 * Metadata for persistent objects
 *
 * The models are a combination of TypeORM Entities and TypeGraphQL Types
 */
@ObjectType({
  description: 'Persistence model which will be saved in DB',
  isAbstract: true,
})
export abstract class CorePersistenceModel {

  // ===========================================================================
  // Properties
  //
  // TestFields: https://typegraphql.ml/docs/types-and-fields.html
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
   * Labels of the object
   */
  @Field(type => [String], { description: 'Labels of the object', nullable: true })
  @Column('simple-array')
  labels: string[] = [];

  /**
   * IDs of the Owners
   */
  @Restricted(RoleEnum.ADMIN, RoleEnum.OWNER)
  @Field(type => [String], { description: 'Users who own the object', nullable: true })
  @Column('simple-array')
  ownerIds: string[] = [];

  /**
   * Tags for the object
   */
  @Field(type => [String], { description: 'Tags for the object', nullable: true })
  @Column('simple-array')
  tags: string[] = [];

  /**
   * Updated date
   */
  @Field({ description: 'Updated date', nullable: true })
  @Column()
  updatedAt: Date;

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
