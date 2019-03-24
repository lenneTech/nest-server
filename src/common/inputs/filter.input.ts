import { Field, InputType } from 'type-graphql';
import { CombinedFilterInput } from './combined-filter.input';
import { SingleFilterInput } from './single-filter.input';

@InputType({ description: 'Input for filtering. The `singleFilter` will be ignored if the `combinedFilter` is set.' })
export class FilterInput {

  @Field(
    type => CombinedFilterInput,
    {
      description: 'Combination of multiple filters via logical operator',
      nullable: true,
    },
  )
  combinedFilter?: CombinedFilterInput;


  @Field(
    type => SingleFilterInput,
    {
      description: 'Filter for a single property',
      nullable: true,
    },
  )
  singleFilter?: SingleFilterInput;
}
