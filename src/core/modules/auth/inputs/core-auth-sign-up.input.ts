import { InputType } from '@nestjs/graphql';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';
import { CoreAuthSignInInput } from './core-auth-sign-in.input';

/**
 * SignUp input
 */
@Restricted(RoleEnum.S_EVERYONE)
@InputType({ description: 'Sign-up input' })
export class CoreAuthSignUpInput extends CoreAuthSignInInput {}
