import { Field, ID, ObjectType } from '@nestjs/graphql';
import * as _ from 'lodash';
import { ModelHelper } from '../helpers/model.helper';
import { Prop, Schema } from '@nestjs/mongoose';
import * as mongoose from 'mongoose';

/**
 * Metadata for persistent objects
 *
 * The models are a combination of Mongoose Entities and TypeGraphQL Types
 */
@ObjectType({
  description: 'Persistence model which will be saved in DB',
  isAbstract: true,
})
@Schema()
export abstract class CorePersistenceModel {
  // ===========================================================================
  // Getter
  // ===========================================================================
  get _id() {
    return new mongoose.Types.ObjectId(this.id);
  }

  // ===========================================================================
  // Properties
  //
  // TestFields: https://typegraphql.ml/docs/types-and-fields.html
  // ===========================================================================
  /**
   * ID of the persistence object as string
   */
  @Field((type) => ID, {
    description: 'ID of the persistence object',
    nullable: true,
  })
  id: string = undefined;

  /**
   * Created date
   */
  @Field({ description: 'Created date', nullable: true })
  @Prop()
  createdAt: Date = new Date();

  /**
   * Labels of the object
   */
  @Field((type) => [String], {
    description: 'Labels of the object',
    nullable: true,
  })
  @Prop([String])
  labels: string[] = [];

  /**
   * IDs of the Owners
   */
  @Field((type) => [String], {
    description: 'Users who own the object',
    nullable: true,
  })
  @Prop([String])
  ownerIds: string[] = [];

  /**
   * Tags for the object
   */
  @Field((type) => [String], {
    description: 'Tags for the object',
    nullable: true,
  })
  @Prop([String])
  tags: string[] = [];

  /**
   * Updated date
   */
  @Field({ description: 'Updated date', nullable: true })
  @Prop({ onUpdate: () => new Date() })
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
   * Map method
   */
  public map(
    data: Partial<this> | Record<string, any>,
    options: {
      cloneDeep?: boolean;
      funcAllowed?: boolean;
      mapId?: boolean;
      merge?: boolean;
    } = {}
  ): this {
    const config = {
      cloneDeep: false,
      funcAllowed: false,
      mapId: false,
      merge: false,
      ...options,
    };

    // Prepare data
    let preparedData = data;
    preparedData = ModelHelper.prepareMap(preparedData, this, config);
    if (config.cloneDeep) {
      preparedData = _.cloneDeep(preparedData);
    }

    // Assign
    if (this['assign'] !== 'function') {
      if (!config.merge) {
        Object.assign(this, preparedData);
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
    const config = {
      cloneDeep: true,
      funcAllowed: false,
      mapId: false,
      merge: false,
      ...options,
    };
    return this.map(data, config);
  }
}
