import { Field, InputType } from '@nestjs/graphql';

import { Restricted } from '../../../../core/common/decorators/restricted.decorator';
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

  @Field({ description: 'firstName', nullable: true })
  @Restricted(RoleEnum.S_EVERYONE)
  firstName: string = undefined;

  @Field({ description: 'lastName', nullable: true })
  @Restricted(RoleEnum.S_EVERYONE)
  lastName: string = undefined;
}
