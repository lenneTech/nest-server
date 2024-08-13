import { Field, InputType } from '@nestjs/graphql';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';
import { CoreInput } from '../../../common/inputs/core-input.input';

/**
 * SignIn input
 */
@Restricted(RoleEnum.S_EVERYONE)
@InputType({ description: 'Sign-in input' })
export class CoreAuthSignInInput extends CoreInput {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  @Restricted(RoleEnum.S_EVERYONE)
  @Field({ description: 'Device ID (is created automatically if it is not set)', nullable: true })
  deviceId?: string = undefined;

  @Restricted(RoleEnum.S_EVERYONE)
  @Field({ description: 'Device description', nullable: true })
  deviceDescription?: string = undefined;

  @Restricted(RoleEnum.S_EVERYONE)
  @Field({ description: 'Email', nullable: false })
  email: string = undefined;

  @Restricted(RoleEnum.S_EVERYONE)
  @Field({ description: 'Password', nullable: false })
  password: string = undefined;
}
