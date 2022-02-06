import { Field, InputType } from '@nestjs/graphql';
import { ComparisonOperatorEnum } from '../enums/comparison-operator.enum';
import { JSON } from '../scalars/json.scalar';
import { CoreInput } from './core-input.input';

/**
 * Input for a configuration of a filter
 */
@InputType({ description: 'Input for a configuration of a filter' })
export class SingleFilterInput extends CoreInput {
  /**
   * Name of the property to be used for the filter'
   */
  @Field({ description: 'Name of the property to be used for the filter' })
  field?: string = undefined;

  /**
   * [Negate operator](https://docs.mongodb.com/manual/reference/operator/query/not/)
   */
  @Field({
    description: '[Negate operator](https://docs.mongodb.com/manual/reference/operator/query/not/)',
    nullable: true,
  })
  not?: boolean = undefined;

  /**
   * [Comparison operator](https://docs.mongodb.com/manual/reference/operator/query-comparison/)
   */
  @Field((type) => ComparisonOperatorEnum, {
    description: '[Comparison operator](https://docs.mongodb.com/manual/reference/operator/query-comparison/)',
  })
  operator?: ComparisonOperatorEnum;

  /**
   * [Options](https://docs.mongodb.com/manual/reference/operator/query/regex/#op._S_options) for
   * [REGEX](https://docs.mongodb.com/manual/reference/operator/query/regex/) operator
   */
  @Field({
    description:
      '[Options](https://docs.mongodb.com/manual/reference/operator/query/regex/#op._S_options) for ' +
      '[REGEX](https://docs.mongodb.com/manual/reference/operator/query/regex/) operator',
    nullable: true,
  })
  options?: string = undefined;

  @Field((type) => JSON, { description: 'Value of the property' })
  value?: any = undefined;
}
