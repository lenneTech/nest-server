import {
  Entity,
  EntityManager,
  EntityMetadata,
  OnInit,
  PrimaryKey,
  Property,
  SerializedPrimaryKey,
  wrap,
} from '@mikro-orm/core';
import { Field, ID, ObjectType } from '@nestjs/graphql';
import * as _ from 'lodash';
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
      merge?: boolean;
    } = {}
  ): T {
    const item = options.item || new this();
    delete options.item;
    return item.map(data, options);
  }

  /**
   * Static map deep method
   *
   * Alias for map with cloneDeep = true
   *
   * MapDeep prevents side effects, because objects will be cloned
   * (cloneDeep = true), but it will be slower than a simple map
   */
  public static mapDeep<T extends CorePersistenceModel>(
    this: new (...args: any[]) => T,
    data: Partial<T> | Record<string, any>,
    options: {
      cloneDeep?: boolean;
      funcAllowed?: boolean;
      item?: T;
      mapId?: boolean;
      merge?: boolean;
    } = {}
  ): T {
    const item = options.item || new this();
    delete options.item;
    return item.mapDeep(data, options);
  }

  /**
   * Get meta data from this MiroORM entity via wrap
   */
  getMeta() {
    return wrap(this, true).__meta;
  }

  /**
   * Get object form this MikroORM entity via wrap
   */
  getObject() {
    return wrap(this).toObject();
  }

  /**
   * Map method
   */
  public map(
    data: Partial<this> | Record<string, any>,
    options: {
      cloneDeep?: boolean;
      em?: EntityManager;
      funcAllowed?: boolean;
      mapId?: boolean;
      merge?: boolean;
    } = {}
  ): this {
    // For MakroORM ignore id and _id during the mapping by default
    const config = {
      cloneDeep: false,
      funcAllowed: false,
      mapId: false,
      merge: false,
      ...options,
    };

    // Prepare data
    let preparedData = data;
    if (preparedData['__meta'] instanceof EntityMetadata) {
      preparedData = wrap(preparedData).toObject();
    }
    preparedData = ModelHelper.prepareMap(preparedData, this, config);
    if (config.cloneDeep) {
      preparedData = _.cloneDeep(preparedData);
    }

    // Assign
    if (this['assign'] !== 'function') {
      if (!config.merge) {
        Object.assign(this, preparedData);
      } else {
        // Warning: em is necessary, error will thrown when missing
        // See https://mikro-orm.io/docs/entity-helper#updating-entity-values-with-entityassign
        wrap(this).assign(preparedData, { em: config.em, mergeObjects: config.merge });
      }
    } else {
      this['assign'](preparedData, { mergeObjects: config.merge });
    }

    // Return
    return this;
  }

  /**
   * Map deep method
   *
   * Alias for map with cloneDeep = true
   *
   * MapDeep prevents side effects, because objects will be cloned
   * (cloneDeep = true), but it will be slower than a simple map
   */
  public mapDeep(
    data: Partial<this> | Record<string, any>,
    options: {
      cloneDeep?: boolean;
      funcAllowed?: boolean;
      mapId?: boolean;
      merge?: boolean;
    } = {}
  ): this {
    // For MakroORM ignore id and _id during the mapping by default
    const config = {
      cloneDeep: true,
      funcAllowed: false,
      mapId: false,
      merge: false,
      ...options,
    };
    return this.map(data, config);
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
