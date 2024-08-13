import { InputType } from '@nestjs/graphql';

import { Restricted } from '../../../../core/common/decorators/restricted.decorator';
import { RoleEnum } from '../../../../core/common/enums/role.enum';
import { CoreAuthSignInInput } from '../../../../core/modules/auth/inputs/core-auth-sign-in.input';

/**
 * SignIn input
 */
@Restricted(RoleEnum.ADMIN)
@InputType({ description: 'Sign-in input' })
export class AuthSignInInput extends CoreAuthSignInInput {
  // Extend UserInput here
}
