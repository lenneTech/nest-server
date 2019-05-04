import { Resolver } from '@nestjs/graphql';
import { CoreAuthResolver } from '../../../core/modules/auth/core-auth.resolver';
import { Auth } from './auth.model';

/**
 * Authentication resolver for the sign in
 */
@Resolver(of => Auth)
export class AuthResolver extends CoreAuthResolver {}
