import { Resolver } from '@nestjs/graphql';
import { UserResolver as CoreUserResolver } from '../../../core/modules/user/user.resolver';
import { User } from './user.model';

/**
 * Resolver to process with user data
 */
@Resolver(of => User)
export class UserResolver extends CoreUserResolver(User) {}
