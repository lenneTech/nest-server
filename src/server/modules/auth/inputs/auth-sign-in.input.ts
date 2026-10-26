import { InputType } from '@nestjs/graphql';

import { Restricted } from '../../../../core/common/decorators/restricted.decorator.js';
import { RoleEnum } from '../../../../core/common/enums/role.enum.js';
import { CoreAuthSignInInput } from '../../../../core/modules/auth/inputs/core-auth-sign-in.input.js';

/**
 * SignIn input
 */
@InputType({ description: 'Sign-in input' })
@Restricted(RoleEnum.ADMIN)
export class AuthSignInInput extends CoreAuthSignInInput {
  // Extend UserInput here
}
