import { Field, ObjectType } from 'type-graphql/dist';
import { User } from '../user/user.model';

/**
 * Auth model
 */
@ObjectType({ description: 'Auth' })
export class Auth {

  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * JavaScript Web Token (JWT)
   */
  @Field({ description: 'JavaScript Web Token (JWT)' })
  token: string;

  /**
   * Signed in user
   */
  @Field(type => User, { description: 'User who signed in' })
  user: User;
}
