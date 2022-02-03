import { IsEmail, IsOptional } from 'class-validator';
import { Field, InputType } from '@nestjs/graphql';
import { Restricted } from '../../../common/decorators/restricted.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';
import { CoreModel } from '../../../common/models/core-model.model';

/**
 * User input to update a user
 */
@InputType({ description: 'User input', isAbstract: true })
export abstract class CoreUserInput extends CoreModel {
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
  roles?: string[] = [];

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
