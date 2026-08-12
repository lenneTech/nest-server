import { InputType } from '@nestjs/graphql';
import { IsEmail, Matches } from 'class-validator';

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
   *
   * System roles (`s_*` prefix, see RoleEnum) are runtime-context checks and must NEVER be stored:
   * `hasRole` is a plain string intersection, so a stored `s_self` would satisfy every S_SELF
   * check (e.g. update/delete of ARBITRARY users) without the account carrying a real role.
   * The @Restricted above limits WHO may send the field; this validator limits WHAT it may hold.
   */
  @Restricted({ processType: ProcessType.INPUT, roles: RoleEnum.ADMIN })
  @UnifiedField({
    isArray: true,
    isOptional: true,
    type: String,
    validator: () => [
      Matches(/^(?!s_)/i, { each: true, message: 'System roles (s_*) must never be stored in user.roles' }),
    ],
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
