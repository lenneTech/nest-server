import { Entity, OnInit, PrimaryKey, Property, SerializedPrimaryKey } from '@mikro-orm/core';
import { Field, ID, ObjectType } from '@nestjs/graphql';
import { ObjectId } from 'mongodb';
import { Restricted } from '../decorators/restricted.decorator';
import { RoleEnum } from '../enums/role.enum';
import { ModelHelper } from '../helpers/model.helper';

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
      funcAllowed?: boolean;
      item?: T;
      mapId?: boolean;
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
      mapId?: boolean;
    } = {}
  ): this {
    // For MakroORM ignore id and _id during the mapping by default
    const config = {
      mapId: false,
      ...options,
    };
    return ModelHelper.map(data, this, config);
  }

  /**
   * On init handling
   *
   * Fired when new instance of entity is created, either manually em.create(),
   * or automatically when new entities are loaded from database
   *
   * @OnInit is not fired when you create the entity manually via its constructor
   * (new MyEntity())
   */
  @OnInit()
  onInit() {
    // Map for deep mapping
    if (typeof this.map === 'function') {
      this.map(this, { cloneDeep: false, funcAllowed: false, mapId: true });
    }
  }
}
