import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { RoleEnum } from '../../../common/enums/role.enum';
import { AuthGuard } from './auth.guard';

/**
 * Role guard
 *
 * The RoleGuard is activated by the Role decorator. It checks whether the current user has at least one of the
 * specified roles or is logged in when the S_USER role is set.
 * If this is not the case, an UnauthorizedException is thrown.
 */
@Injectable()
export class RolesGuard extends AuthGuard('jwt') {
  /**
   * Integrate reflector
   */
  constructor(protected readonly reflector: Reflector) {
    super();
  }

  /**
   * Handle request
   */
  override handleRequest(err, user, info, context) {
    // Get roles
    const reflectorRoles = this.reflector.getAll<string[][]>('roles', [context.getHandler(), context.getClass()]);
    const roles: string[] = reflectorRoles[0]
      ? reflectorRoles[1]
        ? [...reflectorRoles[0], ...reflectorRoles[1]]
        : reflectorRoles[0]
      : reflectorRoles[1];

    // Check if locked
    if (roles && roles.includes(RoleEnum.S_NO_ONE)) {
      throw new UnauthorizedException('No access');
    }

    // Check roles
    if (!roles || !roles.some((value) => !!value)) {
      return user;
    }

    // Check user and user roles
    if (!user?.hasRole?.(roles)) {
      // Get args
      const args: any = GqlExecutionContext.create(context).getArgs();

      // Check special user roles (user is logged in or access is free for any)
      if ((user && roles.includes(RoleEnum.S_USER)) || roles.includes(RoleEnum.S_EVERYONE)) {
        return user;
      }

      // Requester is not authorized
      throw new UnauthorizedException();
    }

    // Everything is ok
    return user;
  }

  /**
   * Integrate request from GraphQL
   */
  getRequest(context: ExecutionContext) {
    const ctx = GqlExecutionContext.create(context);
    return ctx.getContext() ? ctx.getContext().req : context.switchToHttp().getRequest();
  }
}
