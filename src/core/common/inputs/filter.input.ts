import { Field, InputType } from '@nestjs/graphql';

import { Restricted } from '../decorators/restricted.decorator';
import { RoleEnum } from '../enums/role.enum';
import { CombinedFilterInput } from './combined-filter.input';
import { CoreInput } from './core-input.input';
import { SingleFilterInput } from './single-filter.input';

/**
 * Input for filtering. The `singleFilter` will be ignored if the `combinedFilter` is set.
 */
@Restricted(RoleEnum.S_EVERYONE)
@InputType({
  description: 'Input for filtering. The `singleFilter` will be ignored if the `combinedFilter` is set.',
})
export class FilterInput extends CoreInput {
  /**
   * Combination of multiple filters via logical operator
   */
  @Restricted(RoleEnum.S_EVERYONE)
  @Field(type => CombinedFilterInput, {
    description: 'Combination of multiple filters via logical operator',
    nullable: true,
  })
  combinedFilter?: CombinedFilterInput = undefined;

  /**
   * Filter for a single property
   */
  @Restricted(RoleEnum.S_EVERYONE)
  @Field(type => SingleFilterInput, {
    description: 'Filter for a single property',
    nullable: true,
  })
  singleFilter?: SingleFilterInput = undefined;

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
    this.combinedFilter = data.combinedFilter ? CombinedFilterInput.map(data.combinedFilter, options) : undefined;
    this.singleFilter = data.singleFilter ? SingleFilterInput.map(data.singleFilter, options) : undefined;
    Object.keys(this).forEach(key => this[key] === undefined && delete this[key]);
    return this;
  }
}
