import { ObjectType } from 'type-graphql';
import { Auth as CoreAuth } from '../../../core/modules/auth/auth.model';
import { User } from '../user/user.model';

/**
 * Auth model for the response after the sign in
 */
@ObjectType({ description: 'Auth' })
export class Auth extends CoreAuth(User) {}
