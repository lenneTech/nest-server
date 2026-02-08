import { NotFoundException } from '@nestjs/common';
import {
  AggregateOptions,
  Document,
  Model as MongooseModel,
  PipelineStage,
  Query,
  QueryFilter,
  QueryOptions,
} from 'mongoose';

import { FilterArgs } from '../args/filter.args';
import { getStringIds } from '../helpers/db.helper';
import { convertFilterArgsToQuery } from '../helpers/filter.helper';
import { mergePlain, prepareServiceOptionsForCreate } from '../helpers/input.helper';
import { ServiceOptions } from '../interfaces/service-options.interface';
import { CoreModel } from '../models/core-model.model';
import { PaginationInfo } from '../models/pagination-info.model';
import { PlainObject } from '../types/plain-object.type';
import { ConfigService } from './config.service';
import { ModuleService } from './module.service';

export abstract class CrudService<
  Model extends CoreModel = any,
  CreateInput = any,
  UpdateInput = any,
> extends ModuleService<Model> {
  /**
   * Aggregate
   * @param serviceOptions.aggregateOptions Aggregate options, see https://www.mongodb.com/docs/manual/core/aggregation-pipeline/
   * @param serviceOptions.collation Collation, see https://www.mongodb.com/docs/manual/reference/collation/
   * @param serviceOptions.outputPath Output path of items which should be prepared, e.g. 'items'
   */
  async aggregate<T = any>(
    pipeline: PipelineStage[],
    serviceOptions?: ServiceOptions & { aggregateOptions?: AggregateOptions },
  ): Promise<T> {
    return this.process(
      async () => {
        const aggregateOptions = serviceOptions?.aggregateOptions || {};
        const collation = serviceOptions?.collation || ConfigService.get('mongoose.collation');
        if (collation && !aggregateOptions.collation) {
          aggregateOptions.collation = collation;
        }
        return this.mainDbModel.aggregate(pipeline, aggregateOptions).exec();
      },
      { serviceOptions },
    );
  }

  /**
   * Aggregate without checks or restrictions
   * Warning: Disables the handling of rights and restrictions!
   */
  async aggregateForce<T = any>(pipeline: PipelineStage[], serviceOptions: ServiceOptions = {}): Promise<T> {
    serviceOptions = serviceOptions || {};
    serviceOptions.force = true;
    return this.aggregate(pipeline, serviceOptions);
  }

  /**
   * Aggregate without checks, restrictions or preparations
   * Warning: Disables the handling of rights and restrictions! The raw data may contain secrets (such as passwords).
   */
  async aggregateRaw<T = any>(pipeline: PipelineStage[], serviceOptions: ServiceOptions = {}): Promise<T> {
    serviceOptions = serviceOptions || {};
    serviceOptions.raw = true;
    return this.aggregateForce(pipeline, serviceOptions);
  }

  /**
   * Create item
   */
  async create(input: PlainObject<CreateInput>, serviceOptions?: ServiceOptions): Promise<Model> {
    serviceOptions = prepareServiceOptionsForCreate(serviceOptions);
    return this.process(
      async (data) => {
        const currentUserId = serviceOptions?.currentUser?.id;
        return new this.mainDbModel({ ...data.input, createdBy: currentUserId, updatedBy: currentUserId }).save();
      },
      { input, serviceOptions },
    );
  }

  /**
   * Create item without checks or restrictions
   * Warning: Disables the handling of rights and restrictions!
   */
  async createForce(input: PlainObject<CreateInput>, serviceOptions: ServiceOptions = {}): Promise<Model> {
    serviceOptions = serviceOptions || {};
    serviceOptions.force = true;
    return this.create(input, serviceOptions);
  }

  /**
   * Create item without checks, restrictions or preparations
   * Warning: Disables the handling of rights and restrictions! The raw data may contain secrets (such as passwords).
   */
  async createRaw(input: PlainObject<CreateInput>, serviceOptions: ServiceOptions = {}): Promise<Model> {
    serviceOptions = serviceOptions || {};
    serviceOptions.raw = true;
    return this.createForce(input, serviceOptions);
  }

  /**
   * Get distinct values of a property
   */
  distinct(property: string): Promise<string[]> {
    return this.mainDbModel.distinct(property).exec() as Promise<string[]>;
  }

  /**
   * Get item by ID
   */
  async get(id: string, serviceOptions?: ServiceOptions): Promise<Model> {
    const query = this.mainDbModel.findById(id);
    if (serviceOptions?.select) {
      query.select(serviceOptions.select);
    }
    const dbObject = await query.exec();
    if (!dbObject) {
      throw new NotFoundException(`No ${this.mainModelConstructor.name} found with ID: ${id}`);
    }
    return this.process(async () => dbObject, { dbObject, serviceOptions });
  }

  /**
   * Get item by ID without checks or restrictions
   * Warning: Disables the handling of rights and restrictions!
   */
  async getForce(id: string, serviceOptions: ServiceOptions = {}): Promise<Model> {
    serviceOptions = serviceOptions || {};
    serviceOptions.force = true;
    return this.get(id, serviceOptions);
  }

  /**
   * Get item by ID without checks, restrictions or preparations
   * Warning: Disables the handling of rights and restrictions! The raw data may contain secrets (such as passwords).
   */
  async getRaw(id: string, serviceOptions: ServiceOptions = {}): Promise<Model> {
    serviceOptions = serviceOptions || {};
    serviceOptions.raw = true;
    return this.getForce(id, serviceOptions);
  }

  /**
   * Get items via filter
   */
  async find(
    filter?: FilterArgs | { filterQuery?: QueryFilter<any>; queryOptions?: QueryOptions; samples?: number },
    serviceOptions?: ServiceOptions,
  ): Promise<Model[]> {
    // If filter is not instance of FilterArgs a simple form with filterQuery and queryOptions is set
    // and should not be processed as FilterArgs
    if (!(filter instanceof FilterArgs) && serviceOptions?.inputType === FilterArgs) {
      serviceOptions = Object.assign({ prepareInput: null }, serviceOptions, { inputType: null });
    }

    return this.process(
      async (data) => {
        // Return only a certain number of random samples
        if (filter?.samples) {
          return (await this.findAndCount(filter, serviceOptions)).items;
        }

        // Prepare filter query
        const filterQuery = { filterQuery: data?.input?.filterQuery, queryOptions: data?.input?.queryOptions };
        if (data?.input instanceof FilterArgs) {
          const converted = convertFilterArgsToQuery(data.input);
          filterQuery.filterQuery = converted[0];
          filterQuery.queryOptions = converted[1];
        }

        // Find in DB
        let find = this.mainDbModel.find(filterQuery.filterQuery, null, filterQuery.queryOptions);
        const collation = serviceOptions?.collation || ConfigService.get('mongoose.collation');
        if (collation) {
          find = find.collation(collation);
        }
        if (serviceOptions?.select) {
          find = find.select(serviceOptions.select) as any;
        }
        return find.exec();
      },
      { input: filter, serviceOptions },
    );
  }

  /**
   * Get items via filter without checks or restrictions
   * Warning: Disables the handling of rights and restrictions!
   */
  async findForce(
    filter?: FilterArgs | { filterQuery?: QueryFilter<any>; queryOptions?: QueryOptions; samples?: number },
    serviceOptions: ServiceOptions = {},
  ): Promise<Model[]> {
    serviceOptions = serviceOptions || {};
    serviceOptions.force = true;
    return this.find(filter, serviceOptions);
  }

  /**
   * Get items via filter without checks, restrictions or preparations
   * Warning: Disables the handling of rights and restrictions! The raw data may contain secrets (such as passwords).
   */
  async findRaw(
    filter?: FilterArgs | { filterQuery?: QueryFilter<any>; queryOptions?: QueryOptions; samples?: number },
    serviceOptions: ServiceOptions = {},
  ): Promise<Model[]> {
    serviceOptions = serviceOptions || {};
    serviceOptions.raw = true;
    return this.findForce(filter, serviceOptions);
  }

  /**
   * Get items and total count via filter
   */
  async findAndCount(
    filter?: FilterArgs | { filterQuery?: QueryFilter<any>; queryOptions?: QueryOptions; samples?: number },
    serviceOptions?: ServiceOptions,
  ): Promise<{
    items: Model[];
    pagination: PaginationInfo;
    totalCount: number;
  }> {
    // If filter is not instance of FilterArgs a simple form with filterQuery and queryOptions is set
    // and should not be processed as FilterArgs
    if (!(filter instanceof FilterArgs) && serviceOptions?.inputType === FilterArgs) {
      serviceOptions = Object.assign({ prepareInput: null }, serviceOptions, { inputType: null });
    }

    return this.process(
      async (data) => {
        // Prepare filter query
        const filterQuery = { filterQuery: data?.input?.filterQuery, queryOptions: data?.input?.queryOptions };
        if (data?.input instanceof FilterArgs) {
          const converted = convertFilterArgsToQuery(data.input);
          filterQuery.filterQuery = converted[0];
          filterQuery.queryOptions = converted[1];
        }

        // Prepare aggregation (with fixed defined sequence)
        const aggregation: PipelineStage[] = [];

        // Add pipeline stage 1: match
        if (filterQuery.filterQuery) {
          aggregation.push({
            $match: filterQuery.filterQuery,
          });
        }

        // Prepare $facet
        const facet = {
          items: [],
          totalCount: [{ $count: 'total' }],
        };

        // Prepare query options
        if (filterQuery.queryOptions) {
          // Add pipeline stage 2: sort (optional)
          const options = filterQuery.queryOptions;
          if (options.sort) {
            aggregation.push({ $sort: options.sort });
          }

          // Prepare skip / offset in facet
          if (options.skip || options.offset) {
            facet.items.push({ $skip: options.skip || options.offset });
          }

          // Prepare limit / take in facet
          if (options.limit || options.take) {
            facet.items.push({ $limit: options.limit || options.take });
          }
        }

        // Get a certain number of random samples
        if (filter?.samples) {
          facet.items.push({ $sample: { size: filter.samples } });
        }

        // Set pipeline stage 3: facet => items (with skip & limit) and totalCount
        aggregation.push({ $facet: facet });

        // Find and process db items
        const collation = serviceOptions?.collation || ConfigService.get('mongoose.collation');
        const dbResult =
          (await this.mainDbModel.aggregate(aggregation, collation ? { collation } : {}).exec())[0] || {};
        dbResult.totalCount = dbResult.totalCount?.[0]?.total || 0;
        dbResult.items = dbResult.items?.map((item) => this.mainDbModel.hydrate(item)) || [];

        // Calculate pagination info
        const queryOptions = filterQuery.queryOptions || {};
        dbResult.pagination = PaginationInfo.create({
          limit: queryOptions.limit,
          offset: queryOptions.offset,
          skip: queryOptions.skip,
          take: queryOptions.take,
          totalCount: dbResult.totalCount,
        });

        return dbResult;
      },
      { input: filter, outputPath: 'items', serviceOptions },
    );
  }

  /**
   * Get items and total count via filter without checks or restrictions
   * Warning: Disables the handling of rights and restrictions!
   */
  async findAndCountForce(
    filter?: FilterArgs | { filterQuery?: QueryFilter<any>; queryOptions?: QueryOptions; samples?: number },
    serviceOptions: ServiceOptions = {},
  ): Promise<{ items: Model[]; pagination: PaginationInfo; totalCount: number }> {
    serviceOptions.raw = true;
    return this.findAndCount(filter, serviceOptions);
  }

  /**
   * Get items and total count via filter without checks, restrictions or preparations
   * Warning: Disables the handling of rights and restrictions! The raw data may contain secrets (such as passwords).
   */
  async findAndCountRaw(
    filter?: FilterArgs | { filterQuery?: QueryFilter<any>; queryOptions?: QueryOptions; samples?: number },
    serviceOptions: ServiceOptions = {},
  ): Promise<{ items: Model[]; pagination: PaginationInfo; totalCount: number }> {
    serviceOptions = serviceOptions || {};
    serviceOptions.raw = true;
    return this.findAndCountForce(filter, serviceOptions);
  }

  /**
   * Find and update
   */
  async findAndUpdate(
    filter: FilterArgs | { filterQuery?: QueryFilter<any>; queryOptions?: QueryOptions; samples?: number },
    update: PlainObject<UpdateInput>,
    serviceOptions?: ServiceOptions,
  ): Promise<Model[]> {
    const dbItems: Model[] = await this.find(filter, serviceOptions);
    if (!dbItems?.length) {
      return [];
    }
    const promises: Promise<Model>[] = [];
    for (const dbItem of dbItems) {
      promises.push(this.update(getStringIds(dbItem as any), update, serviceOptions));
    }
    return await Promise.all(promises);
  }

  /**
   * Find and update without checks or restrictions
   * Warning: Disables the handling of rights and restrictions!
   */
  async findAndUpdateForce(
    filter: FilterArgs | { filterQuery?: QueryFilter<any>; queryOptions?: QueryOptions; samples?: number },
    update: PlainObject<UpdateInput>,
    serviceOptions: ServiceOptions = {},
  ): Promise<Model[]> {
    serviceOptions = serviceOptions || {};
    serviceOptions.force = true;
    return this.findAndUpdate(filter, update, serviceOptions);
  }

  /**
   * Find and update without checks, restrictions or preparations
   * Warning: Disables the handling of rights and restrictions! The raw data may contain secrets (such as passwords).
   */
  async findAndUpdateRaw(
    filter: FilterArgs | { filterQuery?: QueryFilter<any>; queryOptions?: QueryOptions; samples?: number },
    update: PlainObject<UpdateInput>,
    serviceOptions: ServiceOptions = {},
  ): Promise<Model[]> {
    serviceOptions = serviceOptions || {};
    serviceOptions.raw = true;
    return this.findAndUpdateForce(filter, update, serviceOptions);
  }

  /**
   * Find one item via filter
   */
  async findOne(
    filter?: FilterArgs | { filterQuery?: QueryFilter<any>; queryOptions?: QueryOptions },
    serviceOptions?: ServiceOptions,
  ): Promise<Model> {
    // If filter is not instance of FilterArgs a simple form with filterQuery and queryOptions is set
    // and should not be processed as FilterArgs
    if (!(filter instanceof FilterArgs) && serviceOptions?.inputType === FilterArgs) {
      serviceOptions = Object.assign({ prepareInput: null }, serviceOptions, { inputType: null });
    }

    return this.process(
      async (data) => {
        // Prepare filter query
        const filterQuery = { filterQuery: data?.input?.filterQuery, queryOptions: data?.input?.queryOptions };
        if (data?.input instanceof FilterArgs) {
          const converted = convertFilterArgsToQuery(data.input);
          filterQuery.filterQuery = converted[0];
          filterQuery.queryOptions = converted[1];
        }

        // Find in DB
        let find = this.mainDbModel.findOne(filterQuery.filterQuery, null, filterQuery.queryOptions);
        const collation = serviceOptions?.collation || ConfigService.get('mongoose.collation');
        if (collation) {
          find = find.collation(collation);
        }
        if (serviceOptions?.select) {
          find = find.select(serviceOptions.select) as any;
        }
        return find.exec();
      },
      { input: filter, serviceOptions },
    );
  }

  /**
   * Find one item via filter without checks or restrictions
   * Warning: Disables the handling of rights and restrictions!
   */
  async findOneForce(
    filter?: FilterArgs | { filterQuery?: QueryFilter<any>; queryOptions?: QueryOptions; samples?: number },
    serviceOptions: ServiceOptions = {},
  ): Promise<Model> {
    serviceOptions = serviceOptions || {};
    serviceOptions.force = true;
    return this.findOne(filter, serviceOptions);
  }

  /**
   * Find one item via filter without checks, restrictions or preparations
   * Warning: Disables the handling of rights and restrictions! The raw data may contain secrets (such as passwords).
   */
  async findOneRaw(
    filter?: FilterArgs | { filterQuery?: QueryFilter<any>; queryOptions?: QueryOptions; samples?: number },
    serviceOptions: ServiceOptions = {},
  ): Promise<Model> {
    serviceOptions = serviceOptions || {};
    serviceOptions.raw = true;
    return this.findOneForce(filter, serviceOptions);
  }

  /**
   * Get service model to process queries directly
   * See https://mongoosejs.com/docs/api/model.html
   */
  getModel(): MongooseModel<Document & Model> {
    return this.mainDbModel;
  }

  /**
   * CRUD alias for get
   */
  async read(id: string, serviceOptions?: ServiceOptions): Promise<Model>;

  /**
   * CRUD alias for find
   */
  async read(
    filter: FilterArgs | { filterQuery?: QueryFilter<any>; queryOptions?: QueryOptions },
    serviceOptions?: ServiceOptions,
  ): Promise<Model[]>;

  /**
   * CRUD alias for get or find
   */
  async read(
    input: FilterArgs | string | { filterQuery?: QueryFilter<any>; queryOptions?: QueryOptions },
    serviceOptions?: ServiceOptions,
  ): Promise<Model | Model[]> {
    if (typeof input === 'string') {
      return this.get(input, serviceOptions);
    } else {
      return this.find(input, serviceOptions);
    }
  }

  /**
   * CRUD alias for getForce
   * Warning: Disables the handling of rights and restrictions!
   */
  async readForce(id: string, serviceOptions?: ServiceOptions): Promise<Model>;

  /**
   * CRUD alias for findForce
   * Warning: Disables the handling of rights and restrictions!
   */
  async readForce(
    filter: FilterArgs | { filterQuery?: QueryFilter<any>; queryOptions?: QueryOptions },
    serviceOptions?: ServiceOptions,
  ): Promise<Model[]>;

  /**
   * CRUD alias for getForce or findForce
   * Warning: Disables the handling of rights and restrictions!
   */
  async readForce(
    input: FilterArgs | string | { filterQuery?: QueryFilter<any>; queryOptions?: QueryOptions },
    serviceOptions?: ServiceOptions,
  ): Promise<Model | Model[]> {
    if (typeof input === 'string') {
      return this.getForce(input, serviceOptions);
    } else {
      return this.findForce(input, serviceOptions);
    }
  }

  /**
   * CRUD alias for getRaw
   * Warning: Disables the handling of rights and restrictions! The raw data may contain secrets (such as passwords).
   */
  async readRaw(id: string, serviceOptions?: ServiceOptions): Promise<Model>;

  /**
   * CRUD alias for findRaw
   * Warning: Disables the handling of rights and restrictions! The raw data may contain secrets (such as passwords).
   */
  async readRaw(
    filter: FilterArgs | { filterQuery?: QueryFilter<any>; queryOptions?: QueryOptions },
    serviceOptions?: ServiceOptions,
  ): Promise<Model[]>;

  /**
   * CRUD alias for getRaw or findRaw
   * Warning: Disables the handling of rights and restrictions! The raw data may contain secrets (such as passwords).
   */
  async readRaw(
    input: FilterArgs | string | { filterQuery?: QueryFilter<any>; queryOptions?: QueryOptions },
    serviceOptions?: ServiceOptions,
  ): Promise<Model | Model[]> {
    if (typeof input === 'string') {
      return this.getRaw(input, serviceOptions);
    } else {
      return this.findRaw(input, serviceOptions);
    }
  }

  /**
   * Update item via ID
   */
  async update(id: string, input: PlainObject<UpdateInput>, serviceOptions?: ServiceOptions): Promise<Model> {
    const dbObject = await this.mainDbModel.findById(id).lean();
    if (!dbObject) {
      throw new NotFoundException(`No ${this.mainModelConstructor.name} found with ID: ${id}`);
    }
    return this.process(
      async (data) => {
        const currentUserId = serviceOptions?.currentUser?.id;
        const merged = mergePlain(dbObject, data.input, { updatedBy: currentUserId });
        const query = this.mainDbModel.findByIdAndUpdate(id, merged, { returnDocument: 'after' });
        if (serviceOptions?.select) {
          query.select(serviceOptions.select);
        }
        return await query.exec();
      },
      { dbObject, input, serviceOptions },
    );
  }

  /**
   * Update item via ID without checks or restrictions
   * Warning: Disables the handling of rights and restrictions!
   */
  async updateForce(id: string, input: PlainObject<UpdateInput>, serviceOptions?: ServiceOptions): Promise<Model> {
    serviceOptions = serviceOptions || {};
    serviceOptions.force = true;
    return this.update(id, input, serviceOptions);
  }

  /**
   * Update item via ID without checks, restrictions or preparations
   * Warning: Disables the handling of rights and restrictions! The raw data may contain secrets (such as passwords).
   */
  async updateRaw(id: string, input: PlainObject<UpdateInput>, serviceOptions?: ServiceOptions): Promise<Model> {
    serviceOptions = serviceOptions || {};
    serviceOptions.raw = true;
    return this.updateForce(id, input, serviceOptions);
  }

  /**
   * Delete item via ID
   */
  async delete(id: string, serviceOptions?: ServiceOptions): Promise<Model> {
    const query = this.mainDbModel.findById(id);
    if (serviceOptions?.select) {
      query.select(serviceOptions.select);
    }
    const dbObject = await query.exec();
    if (!dbObject) {
      throw new NotFoundException(`No ${this.mainModelConstructor.name} found with ID: ${id}`);
    }
    return this.process(
      async () => {
        await this.mainDbModel.findByIdAndDelete(id).exec();
        return dbObject;
      },
      { dbObject, serviceOptions },
    );
  }

  /**
   * Delete item via ID without checks or restrictions
   * Warning: Disables the handling of rights and restrictions!
   */
  async deleteForce(id: string, serviceOptions?: ServiceOptions): Promise<Model> {
    serviceOptions = serviceOptions || {};
    serviceOptions.force = true;
    return this.delete(id, serviceOptions);
  }

  /**
   * Delete item via ID without checks, restrictions or preparations
   * Warning: Disables the handling of rights and restrictions! The raw data may contain secrets (such as passwords).
   */
  async deleteRaw(id: string, serviceOptions?: ServiceOptions): Promise<Model> {
    serviceOptions = serviceOptions || {};
    serviceOptions.raw = true;
    return this.deleteForce(id, serviceOptions);
  }

  /**
   * Execute, populate and map Mongoose query or document(s) with serviceOptions
   * Generic T is the type of the returned object(s)
   *
   * @example const user = await this.populateAndProcessQuery<User>(User.findById(id), serviceOptions);
   * @example const users = await this.populateAndProcessQuery<User[]>(User.find({name: {'$regex': 'ma'}}), {...serviceOptions, populate:['contacts'], force: true});
   */
  async processQueryOrDocument<T extends CoreModel | CoreModel[] = CoreModel>(
    queryOrDocument: Document | Document[] | Query<unknown, unknown>,
    serviceOptions?: ServiceOptions,
  ): Promise<T> {
    return this.process(
      () => {
        if (queryOrDocument instanceof Query) {
          if (serviceOptions?.select && queryOrDocument.select && typeof queryOrDocument.select === 'function') {
            queryOrDocument.select(serviceOptions.select);
          }
          return queryOrDocument.exec();
        }
        return queryOrDocument;
      },
      { serviceOptions },
    );
  }
}
