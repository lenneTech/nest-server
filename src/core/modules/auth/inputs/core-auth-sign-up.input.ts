import { InputType } from '@nestjs/graphql';

import { Restricted } from '../../../common/decorators/restricted.decorator.js';
import { RoleEnum } from '../../../common/enums/role.enum.js';
import { CoreAuthSignInInput } from './core-auth-sign-in.input.js';

/**
 * SignUp input
 */
@InputType({ description: 'Sign-up input' })
@Restricted(RoleEnum.S_EVERYONE)
export class CoreAuthSignUpInput extends CoreAuthSignInInput {}
