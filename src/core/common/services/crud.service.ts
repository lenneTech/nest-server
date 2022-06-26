import { NotFoundException } from '@nestjs/common';
import { FilterQuery, QueryOptions } from 'mongoose';
import { FilterArgs } from '../args/filter.args';
import { merge } from '../helpers/config.helper';
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
   * CRUD alias for get
   */
  async read(id: string, serviceOptions?: ServiceOptions): Promise<T>;

  /**
   * CRUD alias for find
   */
  async read(filterArgs?: FilterArgs, serviceOptions?: ServiceOptions): Promise<T[]>;

  /**
   * CRUD alias for get or find
   */
  async read(input: string | FilterArgs, serviceOptions?: ServiceOptions): Promise<T | T[]> {
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
