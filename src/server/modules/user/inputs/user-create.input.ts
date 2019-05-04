import { IsEmail } from 'class-validator';
import { Field, InputType } from 'type-graphql';
import { UserInput } from './user.input';

/**
 * User input to create a new user
 */
@InputType({ description: 'User input to create a new user' })
export class UserCreateInput extends UserInput {

  @Field({ description: 'Email of the user', nullable: false })
  @IsEmail()
  email: string;
}
