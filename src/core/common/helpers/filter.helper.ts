import { FilterQuery, QueryOptions } from 'mongoose';
import { FilterArgs } from '../args/filter.args';
import { ComparisonOperatorEnum } from '../enums/comparison-operator.enum';
import { LogicalOperatorEnum } from '../enums/logical-operator.enum';
import { FilterInput } from '../inputs/filter.input';
import { SortInput } from '../inputs/sort.input';
import { getObjectIds } from './db.helper';
import { assignPlain } from './input.helper';

/**
 * Helper for filter handling
 * @deprecated use functions directly
 */
export class Filter {
  /**
   * Convert filter arguments to a query array
   * @param filterArgs
   */
  public static convertFilterArgsToQuery<T = any>(filterArgs: Partial<FilterArgs>): [FilterQuery<T>, QueryOptions] {
    return convertFilterArgsToQuery(filterArgs);
  }

  /**
   * Generate filter query
   */
  public static generateFilterQuery<T = any>(filter?: Partial<FilterInput>): FilterQuery<T> | any {
    return generateFilterQuery(filter);
  }

  /**
   * Generate find options
   */
  public static generateFindOptions<T = any>(filterArgs: Partial<FilterArgs>): QueryOptions {
    return generateFindOptions(filterArgs);
  }
}

/**
 * Helper function to create $and, $or or $nor filter
 */
export function findFilter(options?: {
  conditions?: Record<string, any>[];
  filterOptions?: FilterQuery<any>;
  id?: any;
  ids?: any[];
  type?: '$and' | '$or' | '$nor';
}): FilterQuery<any> {
  const config = {
    type: '$and',
    ...options,
  };

  // Init filter Option
  let filterOptions: FilterQuery<any> = config?.filterOptions;

  // Check where condition
  if (!filterOptions) {
    filterOptions = {};
    filterOptions[config.type] = [];
  }

  // Convert where condition to array
  if (!Array.isArray(filterOptions?.[config.type])) {
    filterOptions = {};
    filterOptions[config.type] = [config?.filterOptions];
  }

  // ObjectId
  if (config?.id) {
    filterOptions[config.type].push({ _id: getObjectIds(config.id) });
  }

  // ObjectIds
  if (config?.ids) {
    if (!Array.isArray(config.ids)) {
      config.ids = [config.ids];
    }
    filterOptions[config.type].push({ _id: { $in: getObjectIds(config.ids) } });
  }

  // Integrate conditions
  if (config?.conditions) {
    filterOptions[config.type] = [...filterOptions[config.type], ...config.conditions];
  }

  // Filter falsy values
  filterOptions[config.type] = filterOptions[config.type].filter((value) => value);

  // Optimizations
  if (!filterOptions[config.type].length) {
    filterOptions = {};
  } else if (filterOptions[config.type].length === 1) {
    const additionalProperties = filterOptions[config.type][0];
    delete filterOptions[config.type];
    assignPlain(filterOptions, additionalProperties);
  }

  // Return filter config
  return filterOptions;
}

/**
 * Convert filter arguments to a query array
 */
export function convertFilterArgsToQuery<T = any>(filterArgs: Partial<FilterArgs>): [FilterQuery<T>, QueryOptions] {
  return [generateFilterQuery(filterArgs?.filter), generateFindOptions(filterArgs)];
}

/**
 * Generate filter query
 */
export function generateFilterQuery<T = any>(filter?: Partial<FilterInput>): FilterQuery<T> | any {
  // Check filter
  if (!filter) {
    return undefined;
  }

  // Init result
  const result: any = {};

  // Process combined filters
  if (filter.combinedFilter) {
    switch (filter.combinedFilter.logicalOperator) {
      case LogicalOperatorEnum.AND:
        return {
          $and: filter.combinedFilter.filters.map((item: FilterInput) => generateFilterQuery(item)),
        };
      case LogicalOperatorEnum.NOR:
        return {
          $nor: filter.combinedFilter.filters.map((item: FilterInput) => generateFilterQuery(item)),
        };
      case LogicalOperatorEnum.OR:
        return {
          $or: filter.combinedFilter.filters.map((item: FilterInput) => generateFilterQuery(item)),
        };
    }
  }

  // Process single filter
  if (filter.singleFilter) {
    // Init variables
    const { not, options, field, convertToObjectId } = filter.singleFilter;
    let value = filter.singleFilter.value;

    // Convert value to object ID(s)
    if (convertToObjectId) {
      value = getObjectIds(value);
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
        result[field] = not
          ? {
              $not: {
                $regex: new RegExp(value),
                $options: options || '',
              },
            }
          : { $regex: new RegExp(value), $options: options || '' };
        break;
    }
  }

  // Return result
  return result;
}

/**
 * Generate find options
 */
export function generateFindOptions<T = any>(filterArgs: Partial<FilterArgs>): QueryOptions {
  // Check filterArgs
  if (!filterArgs) {
    return {};
  }

  // Get values
  const { limit, offset, skip, sort, take } = filterArgs;

  // Init options
  const options: QueryOptions = {
    limit: limit ? limit : take,
  };

  if (skip > 0 || offset > 0) {
    options.skip = offset ? offset : skip;
  }

  // Check take
  if (!options.limit || options.limit > 100) {
    options.limit = 25;
  }

  // Prepare order
  if (sort) {
    options.sort = {};
    sort.forEach((item: SortInput) => {
      options.sort[item.field] = item.order;
    });
  }

  return options;
}
