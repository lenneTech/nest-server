import { Field, InputType } from 'type-graphql';
import { LogicalOperatorEnum } from '../enums/logical-operator.enum';
import { FilterInput } from './filter.input';

@InputType({ description: 'Combination of multiple filters via logical operator' })
export class CombinedFilterInput {

  @Field(
    type => LogicalOperatorEnum,
    {
      description: 'Logical Operator to combine filters. If set the `filters` must be also set.',
      nullable: true,
    },
  )
  logicalOperator?: LogicalOperatorEnum;


  @Field(
    type => FilterInput,
    {
      description: 'Filters to combine via logical operator. If set `logicalOperator` must be also set.',
      nullable: true,
    },
  )
  filters: FilterInput[];
}
