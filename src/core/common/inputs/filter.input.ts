import { Field, InputType } from '@nestjs/graphql';
import { ModelHelper } from '../helpers/model.helper';
import { CombinedFilterInput } from './combined-filter.input';
import { CoreInput } from './core-input.input';
import { SingleFilterInput } from './single-filter.input';

/**
 * Input for filtering. The `singleFilter` will be ignored if the `combinedFilter` is set.
 */
@InputType({
  description: 'Input for filtering. The `singleFilter` will be ignored if the `combinedFilter` is set.',
})
export class FilterInput extends CoreInput {
  /**
   * Combination of multiple filters via logical operator
   */
  @Field((type) => CombinedFilterInput, {
    description: 'Combination of multiple filters via logical operator',
    nullable: true,
  })
  combinedFilter?: CombinedFilterInput;

  /**
   * Filter for a single property
   */
  @Field((type) => SingleFilterInput, {
    description: 'Filter for a single property',
    nullable: true,
  })
  singleFilter?: SingleFilterInput;

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
    this.combinedFilter = ModelHelper.map(data.combinedFilter, CombinedFilterInput, options);
    this.singleFilter = ModelHelper.map(data.singleFilter as SingleFilterInput, SingleFilterInput, options);
    Object.keys(this).forEach((key) => this[key] === undefined && delete this[key]);
    return this;
  }
}
