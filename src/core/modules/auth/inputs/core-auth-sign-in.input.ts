import { Field, InputType } from '@nestjs/graphql';
import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

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

  @ApiProperty()
  @Field({ description: 'Device ID (is created automatically if it is not set)', nullable: true })
  @IsOptional()
  @IsString()
  @Restricted(RoleEnum.S_EVERYONE)
  deviceId?: string = undefined;

  @ApiProperty()
  @Field({ description: 'Device description', nullable: true })
  @IsOptional()
  @IsString()
  @Restricted(RoleEnum.S_EVERYONE)
  deviceDescription?: string = undefined;

  @ApiProperty()
  @Field({ description: 'Email', nullable: false })
  @IsEmail()
  @IsNotEmpty()
  @Restricted(RoleEnum.S_EVERYONE)
  email: string = undefined;

  @ApiProperty()
  @Field({ description: 'Password', nullable: false })
  @IsNotEmpty()
  @IsString()
  @Restricted(RoleEnum.S_EVERYONE)
  password: string = undefined;
}
