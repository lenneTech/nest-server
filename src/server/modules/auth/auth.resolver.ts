import { Resolver } from '@nestjs/graphql';
import { AuthResolver as CoreAuthResolver } from '../../../core/modules/auth/auth.resolver';
import { Auth } from './auth.model';

/**
 * Authentication resolver for the sign in
 */
@Resolver(of => Auth)
export class AuthResolver extends CoreAuthResolver(Auth) {}
