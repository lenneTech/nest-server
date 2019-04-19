import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { User } from '../../modules/user/user.model';
import { RoleEnum } from '../enums/roles.enum';

/**
 * RolesGuard checks the execution authorizations of resolvers in relation to the current user
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

    if (!roles || !roles.some((value) => !!value)) {
      return true;
    }

    // Init data
    let user: User;
    const ctx: any = GqlExecutionContext.create(context).getContext();
    let args: any = GqlExecutionContext.create(context).getArgs();

    if (ctx) {

      // User from GraphQL context
      user = ctx.user;
    } else {
      const request = context.switchToHttp().getRequest();
      if (request) {
        args = request.body;

        // User from REST context
        user = request.user;
      }
    }

    // Check user and user roles
    if (!user || !user.hasRole(roles)) {

      // Check special role for owner
      if (user && roles.includes(RoleEnum.OWNER) && user.id === args.id) {
        return true;
      }

      // Requester is not authorized
      throw new UnauthorizedException();
    }

    // Everything is ok
    return true;
  }
}
