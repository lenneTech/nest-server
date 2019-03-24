import { IsEmail } from 'class-validator';
import { Field, InputType } from 'type-graphql/dist';
import { UserInput } from './user.input';

@InputType({ description: 'User input to create a new user' })
export class UserCreateInput extends UserInput {

  @Field({ description: 'Email of the user', nullable: false })
  @IsEmail()
  email: string;
}
