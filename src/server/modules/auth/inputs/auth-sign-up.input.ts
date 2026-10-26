import { InputType } from '@nestjs/graphql';

import { Restricted } from '../../../../core/common/decorators/restricted.decorator.js';
import { UnifiedField } from '../../../../core/common/decorators/unified-field.decorator.js';
import { RoleEnum } from '../../../../core/common/enums/role.enum.js';
import { CoreAuthSignUpInput } from '../../../../core/modules/auth/inputs/core-auth-sign-up.input.js';

/**
 * SignUp input
 */
@InputType({ description: 'Sign-up input' })
@Restricted(RoleEnum.ADMIN)
export class AuthSignUpInput extends CoreAuthSignUpInput {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  @UnifiedField({
    description: 'firstName',
    isOptional: true,
    roles: RoleEnum.S_EVERYONE,
  })
  firstName: string = undefined;

  @UnifiedField({
    description: 'lastName',
    isOptional: true,
    roles: RoleEnum.S_EVERYONE,
  })
  lastName: string = undefined;
}
