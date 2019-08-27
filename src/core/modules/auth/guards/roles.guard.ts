import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { RoleEnum } from '../../../common/enums/role.enum';
import { AuthGuard } from './auth.guard';

/**
 * Role guard
 *
 * The RoleGuard is activated by the Role decorator. It checks whether the current user has at least one of the
 * specified roles. If this is not the case, an UnauthorizedException is thrown.
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
  handleRequest(err, user, info, context) {
    // Get roles
    const reflectorRoles = this.reflector.getAll<string[][]>('roles', [
      context.getHandler(),
      context.getClass(),
    ]);
    const roles: string[] = reflectorRoles[0]
      ? reflectorRoles[1]
        ? [...reflectorRoles[0], ...reflectorRoles[1]]
        : reflectorRoles[0]
      : reflectorRoles[1];

    // Check roles
    if (!roles || !roles.some(value => !!value)) {
      return user;
    }

    // Check user and user roles
    if (!user || !user.hasRole(roles)) {
      // Get args
      const args: any = GqlExecutionContext.create(context).getArgs();

      // Check special role for user or owner
      if (
        user &&
        (roles.includes(RoleEnum.USER) ||
          (roles.includes(RoleEnum.OWNER) && user.id.toString() === args.id))
      ) {
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
    return ctx.getContext()
      ? ctx.getContext().req
      : context.switchToHttp().getRequest();
  }
}
