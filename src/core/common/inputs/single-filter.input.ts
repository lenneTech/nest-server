import { Field, InputType } from '@nestjs/graphql';

import { Restricted } from '../decorators/restricted.decorator';
import { UnifiedField } from '../decorators/unified-field.decorator';
import { ComparisonOperatorEnum } from '../enums/comparison-operator.enum';
import { RoleEnum } from '../enums/role.enum';
import { JSON } from '../scalars/json.scalar';
import { CoreInput } from './core-input.input';

/**
 * Input for a configuration of a filter
 */
@InputType({ description: 'Input for a configuration of a filter' })
@Restricted(RoleEnum.S_EVERYONE)
export class SingleFilterInput extends CoreInput {
  /**
   * Convert value to ObjectId
   */

  @UnifiedField({
    description: 'Convert value to ObjectId',
    isOptional: true,
    roles: RoleEnum.S_EVERYONE,
  })
  convertToObjectId?: boolean = undefined;

  /**
   * Name of the property to be used for the filter
   */
  @Field({ description: 'Name of the property to be used for the filter' })
  @Restricted(RoleEnum.S_EVERYONE)
  field: string = undefined;

  /**
   * Process value as reference
   */
  @UnifiedField({
    description: 'Process value as reference',
    isOptional: true,
    roles: RoleEnum.S_EVERYONE,
  })
  isReference?: boolean = undefined;

  /**
   * [Negate operator](https://docs.mongodb.com/manual/reference/operator/query/not/)
   */
  @UnifiedField({
    description: '[Negate operator](https://docs.mongodb.com/manual/reference/operator/query/not/)',
    isOptional: true,
    roles: RoleEnum.S_EVERYONE,
  })
  not?: boolean = undefined;

  /**
   * [Comparison operator](https://docs.mongodb.com/manual/reference/operator/query-comparison/)
   */
  // @Field(() => ComparisonOperatorEnum, {
  //   description: '[Comparison operator](https://docs.mongodb.com/manual/reference/operator/query-comparison/)',
  // })
  // @Restricted(RoleEnum.S_EVERYONE)
  @UnifiedField({
    description: '[Comparison operator](https://docs.mongodb.com/manual/reference/operator/query-comparison/)',
    enum: { enum: ComparisonOperatorEnum },
    roles: RoleEnum.S_EVERYONE,
    type: () => ComparisonOperatorEnum,
  })
  operator: ComparisonOperatorEnum = undefined;

  /**
   * [Options](https://docs.mongodb.com/manual/reference/operator/query/regex/#op._S_options) for
   * [REGEX](https://docs.mongodb.com/manual/reference/operator/query/regex/) operator
   */
  // @Field({
  //   description:
  //     '[Options](https://docs.mongodb.com/manual/reference/operator/query/regex/#op._S_options) for ' +
  //     '[REGEX](https://docs.mongodb.com/manual/reference/operator/query/regex/) operator',
  //   nullable: true,
  // })
  // @Restricted(RoleEnum.S_EVERYONE)
  @UnifiedField({
    description:
      '[Options](https://docs.mongodb.com/manual/reference/operator/query/regex/#op._S_options) for '
      + '[REGEX](https://docs.mongodb.com/manual/reference/operator/query/regex/) operator',
    isOptional: true,
    roles: RoleEnum.S_EVERYONE,
  })
  options?: string = undefined;

  @Field(() => JSON, { description: 'Value of the property' })
  @Restricted(RoleEnum.S_EVERYONE)
  value: any = undefined;
}
