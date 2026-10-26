import { InputType } from '@nestjs/graphql';

import { Restricted } from '../../../../core/common/decorators/restricted.decorator.js';
import { UnifiedField } from '../../../../core/common/decorators/unified-field.decorator.js';
import { RoleEnum } from '../../../../core/common/enums/role.enum.js';
import { CoreUserInput } from '../../../../core/modules/user/inputs/core-user.input.js';

/**
 * User input to update a user
 */
@InputType({ description: 'User input' })
@Restricted(RoleEnum.ADMIN)
export class UserInput extends CoreUserInput {
  // Extend UserInput here
  @UnifiedField({
    description: 'Job Title of the user',
    isOptional: true,
    roles: RoleEnum.ADMIN,
  })
  jobTitle?: string = undefined;
}
