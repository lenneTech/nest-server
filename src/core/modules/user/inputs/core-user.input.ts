import { InputType } from '@nestjs/graphql';
import { IsEmail, IsString, Matches } from 'class-validator';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator';
import { ProcessType } from '../../../common/enums/process-type.enum';
import { RoleEnum, SYSTEM_ROLE_PREFIX, SYSTEM_ROLE_REJECT_PATTERN } from '../../../common/enums/role.enum';
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
   *
   * A rejected value answers HTTP 400 (`Validation failed for 1 field: roles (matches)`, with the
   * per-field message in the response body). `CoreUserCreateInput` inherits this field, so sign-up
   * and user creation are covered too.
   *
   * This validator is the FIRST of three layers, not the only one — it gives the best error
   * message, but a subclass that redeclares `roles` replaces it (MapAndValidatePipe walks the
   * prototype chain child-first and skips a property once a child class has validated it), and
   * `force: true` / direct Mongoose writes never reach it at all. `CoreUserService.setRoles()` and
   * the unconditional `mongooseSystemRolePlugin` close those paths.
   */
  @Restricted({ processType: ProcessType.INPUT, roles: RoleEnum.ADMIN })
  @UnifiedField({
    description: 'Roles of the user (system roles with s_ prefix are rejected)',
    isArray: true,
    isOptional: true,
    type: String,
    // `opts` already carries `each: true` for array fields — do not hardcode it, or array-ness has
    // two sources of truth. Note that supplying `validator` REPLACES the built-in `IsString`, so it
    // is re-declared here explicitly rather than relying on `matches()` rejecting non-strings.
    validator: (opts) => [
      IsString(opts),
      Matches(SYSTEM_ROLE_REJECT_PATTERN, {
        ...opts,
        message: `System roles (${SYSTEM_ROLE_PREFIX}*) must never be stored in user.roles`,
      }),
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
