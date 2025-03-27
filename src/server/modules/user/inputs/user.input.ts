import { InputType } from '@nestjs/graphql';

import { Restricted } from '../../../../core/common/decorators/restricted.decorator';
import { RoleEnum } from '../../../../core/common/enums/role.enum';
import { CoreUserInput } from '../../../../core/modules/user/inputs/core-user.input';

/**
 * User input to update a user
 */
@InputType({ description: 'User input' })
@Restricted(RoleEnum.ADMIN)
export class UserInput extends CoreUserInput {
  // Extend UserInput here
}
