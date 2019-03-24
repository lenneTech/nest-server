import { IsEmail, IsOptional } from 'class-validator';
import { Field, InputType } from 'type-graphql/dist';

@InputType({description: 'User input'})
export class UserInput {

  @Field({description: 'Email of the user', nullable: true })
  @IsOptional()
  @IsEmail()
  email?: string;

  @Field({description: 'First name of the user', nullable: true })
  @IsOptional()
  firstName?: string;

  @Field({description: 'Last name of the user', nullable: true })
  @IsOptional()
  lastName?: string;

  @Field({description: 'Username / alias of the user', nullable: true })
  @IsOptional()
  username?: string;
}
