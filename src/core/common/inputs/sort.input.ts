import { Field, InputType } from '@nestjs/graphql';

import { Restricted } from '../decorators/restricted.decorator';
import { RoleEnum } from '../enums/role.enum';
import { SortOrderEnum } from '../enums/sort-order.emum';
import { CoreInput } from './core-input.input';

/**
 * Sorting the returned elements
 */
@Restricted(RoleEnum.S_EVERYONE)
@InputType({ description: 'Sorting the returned elements' })
export class SortInput extends CoreInput {
  /**
   * Field that is to be used for sorting
   */
  @Restricted(RoleEnum.S_EVERYONE)
  @Field({ description: 'Field that is to be used for sorting' })
  field: string = undefined;

  /**
   * SortInput order of the field
   */
  @Restricted(RoleEnum.S_EVERYONE)
  @Field(type => SortOrderEnum, { description: 'SortInput order of the field' })
  order: SortOrderEnum = undefined;
}
