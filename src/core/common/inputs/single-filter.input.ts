import { Field, InputType } from '@nestjs/graphql';

import { Restricted } from '../decorators/restricted.decorator';
import { ComparisonOperatorEnum } from '../enums/comparison-operator.enum';
import { RoleEnum } from '../enums/role.enum';
import { JSON } from '../scalars/json.scalar';
import { CoreInput } from './core-input.input';

/**
 * Input for a configuration of a filter
 */
@Restricted(RoleEnum.S_EVERYONE)
@InputType({ description: 'Input for a configuration of a filter' })
export class SingleFilterInput extends CoreInput {
  /**
   * Convert value to ObjectId
   */
  @Restricted(RoleEnum.S_EVERYONE)
  @Field({
    description: 'Convert value to ObjectId',
    nullable: true,
  })
  convertToObjectId?: boolean = undefined;

  /**
   * Name of the property to be used for the filter
   */
  @Restricted(RoleEnum.S_EVERYONE)
  @Field({ description: 'Name of the property to be used for the filter' })
  field: string = undefined;

  /**
   * Process value as reference
   */
  @Restricted(RoleEnum.S_EVERYONE)
  @Field({
    description: 'Process value as reference',
    nullable: true,
  })
  isReference?: boolean = undefined;

  /**
   * [Negate operator](https://docs.mongodb.com/manual/reference/operator/query/not/)
   */
  @Restricted(RoleEnum.S_EVERYONE)
  @Field({
    description: '[Negate operator](https://docs.mongodb.com/manual/reference/operator/query/not/)',
    nullable: true,
  })
  not?: boolean = undefined;

  /**
   * [Comparison operator](https://docs.mongodb.com/manual/reference/operator/query-comparison/)
   */
  @Restricted(RoleEnum.S_EVERYONE)
  @Field(type => ComparisonOperatorEnum, {
    description: '[Comparison operator](https://docs.mongodb.com/manual/reference/operator/query-comparison/)',
  })
  operator: ComparisonOperatorEnum = undefined;

  /**
   * [Options](https://docs.mongodb.com/manual/reference/operator/query/regex/#op._S_options) for
   * [REGEX](https://docs.mongodb.com/manual/reference/operator/query/regex/) operator
   */
  @Restricted(RoleEnum.S_EVERYONE)
  @Field({
    description:
      '[Options](https://docs.mongodb.com/manual/reference/operator/query/regex/#op._S_options) for '
      + '[REGEX](https://docs.mongodb.com/manual/reference/operator/query/regex/) operator',
    nullable: true,
  })
  options?: string = undefined;

  @Restricted(RoleEnum.S_EVERYONE)
  @Field(type => JSON, { description: 'Value of the property' })
  value: any = undefined;
}
