import { Field, InputType } from '@nestjs/graphql';
import { IsEmail } from 'class-validator';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';
import { CoreUserInput } from './core-user.input';

/**
 * User input to create a new user
 *
 * HINT: All properties (in this class and all classes that extend this class) must be initialized with undefined,
 * otherwise the property will not be recognized via Object.keys (this is necessary for mapping) or will be initialized
 * with a default value that may overwrite an existing value in the DB.
 */
@InputType({ description: 'User input to create a new user', isAbstract: true })
@Restricted(RoleEnum.S_EVERYONE)
export abstract class CoreUserCreateInput extends CoreUserInput {
  @Field({ description: 'Email of the user', nullable: false })
  @IsEmail()
  @Restricted(RoleEnum.S_EVERYONE)
  override email: string = undefined;
}
