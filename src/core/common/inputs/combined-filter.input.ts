import { Field, InputType } from '@nestjs/graphql';
import { LogicalOperatorEnum } from '../enums/logical-operator.enum';
import { ModelHelper } from '../helpers/model.helper';
import { CoreInput } from './core-input.input';
import { FilterInput } from './filter.input';

@InputType({
  description: 'Combination of multiple filters via logical operator',
})
export class CombinedFilterInput extends CoreInput {
  /**
   * Logical Operator to combine filters. If set the `filters` must be also set.
   */
  @Field((type) => LogicalOperatorEnum, {
    description: 'Logical Operator to combine filters. If set the `filters` must be also set.',
    nullable: true,
  })
  logicalOperator?: LogicalOperatorEnum;

  /**
   * Filters to combine via logical operator. If set `logicalOperator` must be also set.
   */
  @Field((type) => [FilterInput], {
    description: 'Filters to combine via logical operator. If set `logicalOperator` must be also set.',
    nullable: true,
  })
  filters?: FilterInput[];

  // ===================================================================================================================
  // Methods
  // ===================================================================================================================

  /**
   * Mapping for Subtypes
   */
  map(
    data: Partial<this> | Record<string, any>,
    options: {
      cloneDeep?: boolean;
      funcAllowed?: boolean;
      mapId?: boolean;
    } = {}
  ): this {
    super.map(data);
    this.filters = ModelHelper.maps(data.filters, FilterInput, options.cloneDeep);
    Object.keys(this).forEach((key) => this[key] === undefined && delete this[key]);
    return this;
  }
}
