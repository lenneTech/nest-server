import { Entity, PrimaryKey, Property, SerializedPrimaryKey } from '@mikro-orm/core';
import { Field, ID, ObjectType } from '@nestjs/graphql';
import { ObjectId } from 'mongodb';
import { ModelHelper } from '../helpers/model.helper';
import { Restricted } from '../decorators/restricted.decorator';
import { RoleEnum } from '../enums/role.enum';

/**
 * Metadata for persistent objects
 *
 * The models are a combination of MikroORM Entities and TypeGraphQL Types
 */
@ObjectType({
  description: 'Persistence model which will be saved in DB',
  isAbstract: true,
})
@Entity()
export abstract class CorePersistenceModel {
  // ===========================================================================
  // Properties
  //
  // TestFields: https://typegraphql.ml/docs/types-and-fields.html
  // ===========================================================================

  /**
   * ID of the persistence object as ObjectId
   */
  @PrimaryKey()
  _id!: ObjectId;

  /**
   * ID of the persistence object as string
   */
  @Field((type) => ID, {
    description: 'ID of the persistence object',
    nullable: true,
  })
  @SerializedPrimaryKey()
  id: string = undefined;

  /**
   * Created date
   */
  @Field({ description: 'Created date', nullable: true })
  @Property()
  createdAt: Date = new Date();

  /**
   * Labels of the object
   */
  @Field((type) => [String], {
    description: 'Labels of the object',
    nullable: true,
  })
  @Property()
  labels: string[] = [];

  /**
   * IDs of the Owners
   */
  @Restricted(RoleEnum.ADMIN, RoleEnum.OWNER)
  @Field((type) => [String], {
    description: 'Users who own the object',
    nullable: true,
  })
  @Property()
  ownerIds: string[] = [];

  /**
   * Tags for the object
   */
  @Field((type) => [String], {
    description: 'Tags for the object',
    nullable: true,
  })
  @Property()
  tags: string[] = [];

  /**
   * Updated date
   */
  @Field({ description: 'Updated date', nullable: true })
  @Property({ onUpdate: () => new Date() })
  updatedAt: Date = new Date();

  /**
   * Static map method
   */
  public static map<T extends CorePersistenceModel>(
    this: new (...args: any[]) => T,
    data: Partial<T> | Record<string, any>,
    options: {
      cloneDeep?: boolean;
      item?: T;
      funcAllowed?: boolean;
    } = {}
  ): T {
    const item = options.item || new this();
    delete options.item;
    return item.map(data, options);
  }

  /**
   * Map method
   */
  public map(
    data: Partial<this> | Record<string, any>,
    options: {
      cloneDeep?: boolean;
      funcAllowed?: boolean;
    } = {}
  ): this {
    return ModelHelper.map(data, this, options);
  }
}
