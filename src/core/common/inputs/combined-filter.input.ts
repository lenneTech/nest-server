import { Field, InputType } from '@nestjs/graphql';

import { LogicalOperatorEnum } from '../enums/logical-operator.enum';
import { maps } from '../helpers/model.helper';
import { CoreInput } from './core-input.input';
import { FilterInput } from './filter.input';

@InputType({
  description: 'Combination of multiple filters via logical operator',
})
export class CombinedFilterInput extends CoreInput {
  /**
   * Logical Operator to combine filters
   */
  @Field(type => LogicalOperatorEnum, {
    description: 'Logical Operator to combine filters',
  })
  logicalOperator: LogicalOperatorEnum = undefined;

  /**
   * Filters to combine via logical operator
   */
  @Field(type => [FilterInput], {
    description: 'Filters to combine via logical operator',
  })
  filters: FilterInput[] = undefined;

  // ===================================================================================================================
  // Methods
  // ===================================================================================================================

  /**
   * Mapping for Subtypes
   */
  override map(
    data: Partial<this> | Record<string, any>,
    options: {
      cloneDeep?: boolean;
      funcAllowed?: boolean;
      mapId?: boolean;
    } = {},
  ): this {
    super.map(data, options);
    this.filters = maps(data.filters, FilterInput, options.cloneDeep);
    Object.keys(this).forEach(key => this[key] === undefined && delete this[key]);
    return this;
  }
}
