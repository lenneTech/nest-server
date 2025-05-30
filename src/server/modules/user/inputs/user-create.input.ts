import { Field, InputType } from '@nestjs/graphql';
import { IsOptional } from 'class-validator';

import { Restricted } from '../../../../core/common/decorators/restricted.decorator';
import { RoleEnum } from '../../../../core/common/enums/role.enum';
import { CoreUserCreateInput } from '../../../../core/modules/user/inputs/core-user-create.input';

/**
 * User input to create a new user
 */
@InputType({ description: 'User input to create a new user' })
@Restricted(RoleEnum.ADMIN)
export class UserCreateInput extends CoreUserCreateInput {
  // Extend UserCreateInput here
  @Field(() => String, {
    description: 'Job Title of the user',
    nullable: true,
  })
  @IsOptional()
  @Restricted(RoleEnum.ADMIN)
  jobTitle?: string = undefined;
}
