import { InputType } from '@nestjs/graphql';
import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';
import { CoreInput } from '../../../common/inputs/core-input.input';

/**
 * SignIn input
 */
@InputType({ description: 'Sign-in input' })
@Restricted(RoleEnum.S_EVERYONE)
export class CoreAuthSignInInput extends CoreInput {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  @UnifiedField({
    description: 'Device ID (is created automatically if it is not set)',
    isOptional: true,
    roles: RoleEnum.S_EVERYONE,
    validator: () => [IsString()],
  })
  deviceId?: string = undefined;

  @UnifiedField({
    description: 'Device description',
    isOptional: true,
    roles: RoleEnum.S_EVERYONE,
    validator: () => [IsString()],
  })
  deviceDescription?: string = undefined;

  @UnifiedField({
    description: 'Email',
    isOptional: false,
    roles: RoleEnum.S_EVERYONE,
    validator: () => [IsEmail(), IsString(), IsNotEmpty()],
  })
  email: string = undefined;

  @UnifiedField({
    description: 'Password',
    isOptional: false,
    roles: RoleEnum.S_EVERYONE,
    validator: () => [IsString(), IsNotEmpty()],
  })
  password: string = undefined;
}
