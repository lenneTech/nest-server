import { InputType } from '@nestjs/graphql';

import { Restricted } from '../decorators/restricted.decorator';
import { UnifiedField } from '../decorators/unified-field.decorator';
import { LogicalOperatorEnum } from '../enums/logical-operator.enum';
import { RoleEnum } from '../enums/role.enum';
import { maps } from '../helpers/model.helper';
import { CoreInput } from './core-input.input';
import { FilterInput } from './filter.input';

@InputType({
  description: 'Combination of multiple filters via logical operator',
})
@Restricted(RoleEnum.S_EVERYONE)
export class CombinedFilterInput extends CoreInput {
  /**
   * Logical Operator to combine filters
   */
  @UnifiedField({
    description: 'Logical Operator to combine filters',
  })
  logicalOperator: LogicalOperatorEnum = undefined;

  /**
   * Filters to combine via logical operator
   */
  @UnifiedField({
    description: 'Filters to combine via logical operator',
    isOptional: true,
    roles: RoleEnum.S_EVERYONE,
    type: () => FilterInput,
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
