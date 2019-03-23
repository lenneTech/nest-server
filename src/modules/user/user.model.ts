import { IsEmail, IsOptional } from 'class-validator';
import { Field, ObjectType } from 'type-graphql/dist';
import { PersistenceModel } from '../../common/models/persistence.model';

/**
 * User model
 */
@ObjectType({description: 'User'})
export class User extends PersistenceModel {

  /**
   * E-Mail address of the user
   */
  @Field({description: 'Email of the user'})
  @IsEmail()
  email: string;

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
}
