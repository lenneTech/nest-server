import { Field, InputType } from '@nestjs/graphql';
import { CombinedFilterInput } from './combined-filter.input';
import { SingleFilterInput } from './single-filter.input';

/**
 * Input for filtering. The `singleFilter` will be ignored if the `combinedFilter` is set.
 */
@InputType({
  description: 'Input for filtering. The `singleFilter` will be ignored if the `combinedFilter` is set.',
})
export class FilterInput {
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
}
