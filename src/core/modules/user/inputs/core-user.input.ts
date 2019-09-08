import { IsEmail, IsOptional } from 'class-validator';
import { Field, InputType } from 'type-graphql';
import { Column } from 'typeorm';
import { Restricted } from '../../../../core/common/decorators/restricted.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';

/**
 * User input to update a user
 */
@InputType({ description: 'User input', isAbstract: true })
export abstract class CoreUserInput {
  /**
   * Email of the user
   */
  @Field({ description: 'Email of the user', nullable: true })
  @IsOptional()
  @IsEmail()
  email?: string;

  /**
   * First name of the user
   */
  @Field({ description: 'First name of the user', nullable: true })
  @IsOptional()
  firstName?: string;

  /**
   * Last name of the user
   */
  @Field({ description: 'Last name of the user', nullable: true })
  @IsOptional()
  lastName?: string;

  /**
   * Roles of the user
   */
  @Restricted(RoleEnum.ADMIN, RoleEnum.OWNER)
  @Field(type => [String], { description: 'Roles of the user', nullable: true })
  @IsOptional()
  @Column()
  roles?: string[];

  /**
   * Username / alias of the user
   */
  @Field({ description: 'Username / alias of the user', nullable: true })
  @IsOptional()
  username?: string;

  /**
   * Password of the user
   */
  @Field({ description: 'Password of the user', nullable: true })
  @IsOptional()
  password?: string;
}
