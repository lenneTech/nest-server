import { InputType } from '@nestjs/graphql';

import { Restricted } from '../../../../core/common/decorators/restricted.decorator';
import { UnifiedField } from '../../../../core/common/decorators/unified-field.decorator';
import { RoleEnum } from '../../../../core/common/enums/role.enum';
import { CoreAuthSignUpInput } from '../../../../core/modules/auth/inputs/core-auth-sign-up.input';

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
