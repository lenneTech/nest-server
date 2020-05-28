import { IsEmail } from 'class-validator';
import { Field, InputType } from '@nestjs/graphql';
import { CoreUserInput } from './core-user.input';

/**
 * User input to create a new user
 */
@InputType({ description: 'User input to create a new user', isAbstract: true })
export abstract class CoreUserCreateInput extends CoreUserInput {
  @Field({ description: 'Email of the user', nullable: false })
  @IsEmail()
  email: string;
}
