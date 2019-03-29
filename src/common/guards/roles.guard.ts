import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { User } from '../../modules/user/user.model';

/**
 * Guard for user roles
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {
  }

  /**
   * The resolver can be activated if the current user has the required roles
   */
  canActivate(context: ExecutionContext): boolean {

    // Check roles
    const roles = this.reflector.getAll<string[]>('roles', [
      context.getHandler(), context.getClass(),
    ]);
    if (!roles) {
      return true;
    }

    // Get user
    let user: User;
    const ctx = GqlExecutionContext.create(context).getContext();
    if (ctx) {

      // User from GraphQL context
      user = ctx.user;
    } else {
      const request = context.switchToHttp().getRequest();
      if (request) {

        // User from REST context
        user = request.user;
      }
    }

    // Check user and user roles
    if (!user || !user.hasRole(roles)) {
      throw new UnauthorizedException();
    }

    // Everything is ok
    return true;
  }
}
