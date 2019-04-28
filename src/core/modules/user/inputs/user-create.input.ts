import { IsEmail } from 'class-validator';
import { Field } from 'type-graphql';
import { InputType } from 'type-graphql/dist/decorators/InputType';
import { UserInput } from './user.input';

/**
 * User input to create a new user
 */
@InputType({ description: 'User input to create a new user', isAbstract: true })
export class UserCreateInput extends UserInput {

  @Field({ description: 'Email of the user', nullable: false })
  @IsEmail()
  email: string;
}
