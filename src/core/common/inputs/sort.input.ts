import { InputType } from '@nestjs/graphql';

import { Restricted } from '../decorators/restricted.decorator';
import { UnifiedField } from '../decorators/unified-field.decorator';
import { RoleEnum } from '../enums/role.enum';
import { SortOrderEnum } from '../enums/sort-order.emum';
import { CoreInput } from './core-input.input';

/**
 * Sorting the returned elements
 */
@InputType({ description: 'Sorting the returned elements' })
@Restricted(RoleEnum.S_EVERYONE)
export class SortInput extends CoreInput {
  /**
   * Field that is to be used for sorting
   */
  @UnifiedField({
    description: 'Field that is to be used for sorting',
    roles: RoleEnum.S_EVERYONE,
  })
  field: string = undefined;

  /**
   * SortInput order of the field
   */
  @UnifiedField({
    description: 'SortInput order of the field',
    enum: { enum: SortOrderEnum },
    roles: RoleEnum.S_EVERYONE,
  })
  order: SortOrderEnum = undefined;
}
