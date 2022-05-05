import { NotFoundException } from '@nestjs/common';
import { FilterArgs } from '../args/filter.args';
import { merge } from '../helpers/config.helper';
import { convertFilterArgsToQuery } from '../helpers/filter.helper';
import { ServiceOptions } from '../interfaces/service-options.interface';
import { CoreModel } from '../models/core-model.model';
import { ModuleService } from './module.service';

export abstract class CrudService<T extends CoreModel = any> extends ModuleService<T> {
  /**
   * Create item
   */
  async create(input: any, serviceOptions?: ServiceOptions): Promise<T> {
    merge({ prepareInput: { create: true } }, serviceOptions);
    return this.process(
      async (data) => {
        return new this.mainDbModel({ ...data.input }).save();
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
  async find(filterArgs?: FilterArgs, serviceOptions?: ServiceOptions): Promise<T[]> {
    return this.process(
      async (data) => {
        const filterQuery = convertFilterArgsToQuery(data.input);
        return this.mainDbModel.find(filterQuery[0], null, filterQuery[1]).exec();
      },
      { input: filterArgs, serviceOptions }
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
        return await Object.assign(dbObject, data.input).save();
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
      async (data) => {
        await this.mainDbModel.findByIdAndDelete(id).exec();
        return dbObject;
      },
      { dbObject, input: id, serviceOptions }
    );
  }
}
