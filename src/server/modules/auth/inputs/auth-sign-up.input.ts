import { Field, InputType } from '@nestjs/graphql';

import { Restricted } from '../../../../core/common/decorators/restricted.decorator';
import { RoleEnum } from '../../../../core/common/enums/role.enum';
import { CoreAuthSignUpInput } from '../../../../core/modules/auth/inputs/core-auth-sign-up.input';

/**
 * SignUp input
 */
@Restricted(RoleEnum.ADMIN)
@InputType({ description: 'Sign-up input' })
export class AuthSignUpInput extends CoreAuthSignUpInput {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  @Restricted(RoleEnum.S_EVERYONE)
  @Field({ description: 'firstName', nullable: true })
  firstName: string = undefined;

  @Restricted(RoleEnum.S_EVERYONE)
  @Field({ description: 'lastName', nullable: true })
  lastName: string = undefined;
}
