import { ObjectID } from 'mongodb';
import { FindManyOptions } from 'typeorm';
import { FilterArgs } from '../args/filter.args';
import { ComparisonOperatorEnum } from '../enums/comparison-operator.enum';
import { LogicalOperatorEnum } from '../enums/logical-operator.enum';
import { FilterInput } from '../inputs/filter.input';
import { SortInput } from '../inputs/sort.input';

/**
 * Helper for filter handling
 */
export class Filter {

  /**
   * Convert GraphQL filter input to Mongoose
   */
  public static convertFilterInput(filter?: FilterInput, config?: {dbType?: string}) {

    // Check filter
    if (!filter) {
      return undefined;
    }

    // Configuration
    config = Object.assign({dbType: 'mongodb'}, config);

    // Init result
    const result: any = {};

    // Process combined filters
    if (filter.combinedFilter) {
      switch (filter.combinedFilter.logicalOperator) {
        case LogicalOperatorEnum.AND:
          return { $and: filter.combinedFilter.filters.map((item: FilterInput) => Filter.convertFilterInput(item)) };
        case LogicalOperatorEnum.NOR:
          return { $nor: filter.combinedFilter.filters.map((item: FilterInput) => Filter.convertFilterInput(item)) };
        case LogicalOperatorEnum.OR:
          return { $or: filter.combinedFilter.filters.map((item: FilterInput) => Filter.convertFilterInput(item)) };
      }
    }

    // Process single filter
    if (filter.singleFilter) {

      // Init variables
      const { not, options } = filter.singleFilter;
      let { field, value } = filter.singleFilter;

      // Prepare fields
      if (field === 'id' && config.dbType === 'mongodb') {
        field = '_id';
      }

      // Prepare values
      if (field === '_id') {
        if (Array.isArray(value)) {
          value = value.map((item: string) => new ObjectID(item));
        } else if (value) {
          value = new ObjectID(value);
        }
      }

      // Convert filter
      switch (filter.singleFilter.operator) {
        case ComparisonOperatorEnum.EQ:
          result[field] = not ? { $ne: value } : value;
          break;
        case ComparisonOperatorEnum.GT:
          result[field] = not ? { $not: { $gt: value } } : { $gt: value };
          break;
        case ComparisonOperatorEnum.GTE:
          result[field] = not ? { $not: { $gte: value } } : { $gte: value };
          break;
        case ComparisonOperatorEnum.IN:
          result[field] = not ? { $nin: value } : { $in: value };
          break;
        case ComparisonOperatorEnum.LT:
          result[field] = not ? { $not: { $lt: value } } : { $lt: value };
          break;
        case ComparisonOperatorEnum.LTE:
          result[field] = not ? { $not: { $lte: value } } : { $lte: value };
          break;
        case ComparisonOperatorEnum.NE:
          result[field] = not ? value : { $ne: value };
          break;
        case ComparisonOperatorEnum.NIN:
          result[field] = not ? { $in: value } : { $nin: value };
          break;
        case ComparisonOperatorEnum.REGEX:
          result[field] = not ? {
            $not: {
              $regex: new RegExp(value),
              $options: options || '',
            },
          } : { $regex: new RegExp(value), $options: options || '' };
          break;
      }
    }

    // Return result
    return result;
  }

  /**
   * Generate FindManyOptions form FilterArgs
   */
  public static generateFilterOptions(filterArgs: FilterArgs, config?: {dbType?: string}): FindManyOptions {

    // Check filterArgs
    if (!filterArgs) {
      return {};
    }

    // Configuration
    config = Object.assign({dbType: 'mongodb'}, config);

    // Get values
    const { filter, take, skip, sort } = filterArgs;

    // Init options
    const options: FindManyOptions = Object.assign({}, { take, skip });

    // Check take
    if (!options.take || options.take > 100) {
      options.take = 25;
    }

    // Prepare where
    if (filter) {
      options.where = Filter.convertFilterInput(filterArgs.filter, config);
    }

    // Prepare order
    if (sort) {
      options.order = {};
      sort.forEach((item: SortInput) => {
        options.order[item.field] = item.order;
      });
    }

    return options;
  }

}
