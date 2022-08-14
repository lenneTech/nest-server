import { NotFoundException } from '@nestjs/common';
import { FilterQuery, PipelineStage, QueryOptions } from 'mongoose';
import { FilterArgs } from '../args/filter.args';
import { merge } from '../helpers/config.helper';
import { getStringIds } from '../helpers/db.helper';
import { convertFilterArgsToQuery } from '../helpers/filter.helper';
import { assignPlain } from '../helpers/input.helper';
import { ServiceOptions } from '../interfaces/service-options.interface';
import { CoreModel } from '../models/core-model.model';
import { ModuleService } from './module.service';

export abstract class CrudService<T extends CoreModel = any> extends ModuleService<T> {
  /**
   * Create item
   */
  async create(input: any, serviceOptions?: ServiceOptions): Promise<T> {
    serviceOptions = merge({ prepareInput: { create: true } }, serviceOptions);
    return this.process(
      async (data) => {
        const currentUserId = serviceOptions?.currentUser?.id;
        return new this.mainDbModel({ ...data.input, createdBy: currentUserId, updatedBy: currentUserId }).save();
      },
      { input, serviceOptions }
    );
  }

  /**
   * Get item by ID
   */
  async get(id: string, serviceOptions?: ServiceOptions): Promise<T> {
    const dbObject = await this.mainDbModel.findById(id).exec();
    if (!dbObject) {
      throw new NotFoundException(`No ${this.mainModelConstructor.name} found with ID: ${id}`);
    }
    return this.process(async () => dbObject, { dbObject, serviceOptions });
  }

  /**
   * Get items via filter
   */
  async find(
    filter?: FilterArgs | { filterQuery?: FilterQuery<any>; queryOptions?: QueryOptions },
    serviceOptions?: ServiceOptions
  ): Promise<T[]> {
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
        return this.mainDbModel.find(filterQuery.filterQuery, null, filterQuery.queryOptions).exec();
      },
      { input: filter, serviceOptions }
    );
  }

  /**
   * Get items and total count via filter
   */
  async findAndCount(
    filter?: FilterArgs | { filterQuery?: FilterQuery<any>; queryOptions?: QueryOptions },
    serviceOptions?: ServiceOptions
  ): Promise<{ items: T[]; totalCount: number }> {
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
        const aggregation: PipelineStage[] = [
          {
            // Add pipeline stage 1: match
            $match: filterQuery.filterQuery,
          },
        ];

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

        // Set pipeline stage 3: facet => items (with skip & limit) and totalCount
        aggregation.push({ $facet: facet });

        // Find and process db items
        const dbResult = (await this.mainDbModel.aggregate(aggregation).exec())[0];
        dbResult.totalCount = dbResult.totalCount[0].total;
        dbResult.items = dbResult.items.map((item) => this.mainDbModel.hydrate(item));
        return dbResult;
      },
      { input: filter, outputPath: 'items', serviceOptions }
    );
  }

  /**
   * Find and update
   */
  async findAndUpdate(
    filter: FilterArgs | { filterQuery?: FilterQuery<any>; queryOptions?: QueryOptions },
    update: any,
    serviceOptions?: ServiceOptions
  ): Promise<T[]> {
    const dbItems: T[] = await this.find(filter, serviceOptions);
    if (!dbItems?.length) {
      return [];
    }
    const promises: Promise<T>[] = [];
    for (const dbItem of dbItems) {
      promises.push(
        new Promise(async (resolve, reject) => {
          try {
            const item = await this.update(getStringIds(dbItem as any), update, serviceOptions);
            resolve(item);
          } catch (e) {
            reject(e);
          }
        })
      );
    }
    return await Promise.all(promises);
  }

  /**
   * CRUD alias for get
   */
  async read(id: string, serviceOptions?: ServiceOptions): Promise<T>;

  /**
   * CRUD alias for find
   */
  async read(
    filter: FilterArgs | { filterQuery?: FilterQuery<any>; queryOptions?: QueryOptions },
    serviceOptions?: ServiceOptions
  ): Promise<T[]>;

  /**
   * CRUD alias for get or find
   */
  async read(
    input: string | FilterArgs | { filterQuery?: FilterQuery<any>; queryOptions?: QueryOptions },
    serviceOptions?: ServiceOptions
  ): Promise<T | T[]> {
    if (typeof input === 'string') {
      return this.get(input, serviceOptions);
    } else {
      return this.find(input, serviceOptions);
    }
  }

  /**
   * Update item via ID
   */
  async update(id: string, input: any, serviceOptions?: ServiceOptions): Promise<T> {
    const dbObject = await this.mainDbModel.findById(id).exec();
    if (!dbObject) {
      throw new NotFoundException(`No ${this.mainModelConstructor.name} found with ID: ${id}`);
    }
    return this.process(
      async (data) => {
        const currentUserId = serviceOptions?.currentUser?.id;
        return await assignPlain(dbObject, data.input, { updatedBy: currentUserId }).save();
      },
      { dbObject, input, serviceOptions }
    );
  }

  /**
   * Delete item via ID
   */
  async delete(id: string, serviceOptions?: ServiceOptions): Promise<T> {
    const dbObject = await this.mainDbModel.findById(id).exec();
    if (!dbObject) {
      throw new NotFoundException(`No ${this.mainModelConstructor.name} found with ID: ${id}`);
    }
    return this.process(
      async () => {
        await this.mainDbModel.findByIdAndDelete(id).exec();
        return dbObject;
      },
      { dbObject, serviceOptions }
    );
  }
}
