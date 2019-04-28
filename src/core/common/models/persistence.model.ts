import { Type } from '@nestjs/common';
import { Field, ID, ObjectType } from 'type-graphql';
import { BeforeInsert, BeforeUpdate, Column, JoinColumn, ObjectIdColumn, OneToOne } from 'typeorm';
import { IAuthUser } from '../../modules/auth/interfaces/auth-user.interface';
import { Restricted } from '../decorators/restricted.decorator';
import { RoleEnum } from '../enums/roles.enum';
import { IPersistenceModel } from '../interfaces/persistence-model.interface';

/**
 * Function to create PersistenceModel
 */
function createPersistenceModel(userClass: Type<IAuthUser>): Type<IPersistenceModel> {

  /**
   * Metadata for persistent objects
   *
   * The models are a combination of TypeORM Entities and TypeGraphQL Types
   */
  @ObjectType({
    description: 'Persistence model which will be saved in DB',
    isAbstract: true,
  })
  class PersistenceModelClass {

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
     * User who created the object
     *
     * Not set when created by system
     */
    @Field(type => userClass, { description: 'User who created the object', nullable: true })
    @OneToOne(type => userClass)
    @JoinColumn()
    createdBy?: IAuthUser;

    /**
     * IDs of the Owners
     */
    @Restricted(RoleEnum.ADMIN, RoleEnum.OWNER)
    @Field(type => [String], { description: 'Users who own the object', nullable: true })
    @Column()
    ownerIds: string[] = [];

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
    @Field(type => userClass, { description: 'User who last updated the object', nullable: true })
    @OneToOne(type => userClass)
    @JoinColumn()
    updatedBy?: IAuthUser;

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

  return PersistenceModelClass;
}

/**
 * PersistenceModel
 */
export const PersistenceModel = createPersistenceModel;
