import { InputType } from '@nestjs/graphql';
import { IsEmail } from 'class-validator';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator';
import { ProcessType } from '../../../common/enums/process-type.enum';
import { RoleEnum } from '../../../common/enums/role.enum';
import { CoreInput } from '../../../common/inputs/core-input.input';

/**
 * User input to update a user
 *
 * HINT: All properties (in this class and all classes that extend this class) must be initialized with undefined,
 * otherwise the property will not be recognized via Object.keys (this is necessary for mapping) or will be initialized
 * with a default value that may overwrite an existing value in the DB.
 */
@InputType({ description: 'User input', isAbstract: true })
@Restricted(RoleEnum.S_EVERYONE)
export abstract class CoreUserInput extends CoreInput {
  /**
   * Email of the user
   */
  @UnifiedField({
    description: 'Email of the user',
    isOptional: true,
    roles: RoleEnum.S_EVERYONE,
    validator: () => [IsEmail()],
  })
  email?: string = undefined;

  /**
   * First name of the user
   */
  @UnifiedField({
    description: 'Last name of the user',
    isOptional: true,
    roles: RoleEnum.S_EVERYONE,
  })
  firstName?: string = undefined;

  /**
   * Last name of the user
   */
  @UnifiedField({
    description: 'Last name of the user',
    isOptional: true,
    roles: RoleEnum.S_EVERYONE,
  })
  lastName?: string = undefined;

  /**
   * Roles of the user
   */
  @Restricted({ processType: ProcessType.INPUT, roles: RoleEnum.ADMIN })
  @UnifiedField({
    isArray: true,
    isOptional: true,
    type: String,
  })
  roles?: string[] = undefined;

  /**
   * Username / alias of the user
   */
  @UnifiedField({
    description: 'Username / alias of the user',
    isOptional: true,
    roles: RoleEnum.S_EVERYONE,
  })
  username?: string = undefined;

  /**
   * Password of the user
   */
  @UnifiedField({
    description: 'Password of the user',
    isOptional: true,
    roles: RoleEnum.S_EVERYONE,
  })
  password?: string = undefined;
}
