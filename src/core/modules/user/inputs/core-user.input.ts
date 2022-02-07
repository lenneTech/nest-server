import { IsEmail, IsOptional } from 'class-validator';
import { Field, InputType } from '@nestjs/graphql';
import { Restricted } from '../../../common/decorators/restricted.decorator';
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
export abstract class CoreUserInput extends CoreInput {
  /**
   * Email of the user
   */
  @Field({ description: 'Email of the user', nullable: true })
  @IsOptional()
  @IsEmail()
  email?: string = undefined;

  /**
   * First name of the user
   */
  @Field({ description: 'First name of the user', nullable: true })
  @IsOptional()
  firstName?: string = undefined;

  /**
   * Last name of the user
   */
  @Field({ description: 'Last name of the user', nullable: true })
  @IsOptional()
  lastName?: string = undefined;

  /**
   * Roles of the user
   */
  @Restricted(RoleEnum.ADMIN)
  @Field((type) => [String], { description: 'Roles of the user', nullable: true })
  @IsOptional()
  roles?: string[] = undefined;

  /**
   * Username / alias of the user
   */
  @Field({ description: 'Username / alias of the user', nullable: true })
  @IsOptional()
  username?: string = undefined;

  /**
   * Password of the user
   */
  @Field({ description: 'Password of the user', nullable: true })
  @IsOptional()
  password?: string = undefined;
}
