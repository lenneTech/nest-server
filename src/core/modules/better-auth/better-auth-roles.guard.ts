import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';

import { RoleEnum } from '../../common/enums/role.enum';
import { ErrorCode } from '../error-code';
import { BetterAuthTokenService } from './better-auth-token.service';
import { BetterAuthenticatedUser } from './better-auth.types';
import { CoreBetterAuthModule } from './core-better-auth.module';

/**
 * BetterAuth Roles Guard
 *
 * A simplified roles guard for BetterAuth (IAM-only) mode that does NOT extend AuthGuard.
 * This avoids the mixin inheritance DI issues that occur with the standard RolesGuard.
 *
 * In IAM-only mode, authentication is handled by CoreBetterAuthMiddleware which:
 * 1. Validates JWT tokens or session tokens
 * 2. Sets req.user with the authenticated user (with _authenticatedViaBetterAuth flag)
 *
 * If the middleware hasn't set req.user (e.g., in test environments), this guard will
 * try to verify the token directly using BetterAuthTokenService.
 *
 * No Passport integration is needed because BetterAuth handles all token validation.
 *
 * IMPORTANT: This guard has NO constructor dependencies. This is intentional because
 * NestJS DI has issues resolving Reflector/ModuleRef for APP_GUARD providers in dynamic modules.
 * Instead, we use Reflect.getMetadata directly to read decorator metadata, and access
 * BetterAuthTokenService via CoreBetterAuthModule static reference.
 */
@Injectable()
export class BetterAuthRolesGuard implements CanActivate {
  private readonly logger = new Logger(BetterAuthRolesGuard.name);
  private tokenService: BetterAuthTokenService | null = null;

  /**
   * Get BetterAuthTokenService lazily from CoreBetterAuthModule
   * This avoids DI issues while still allowing token verification
   */
  private getTokenService(): BetterAuthTokenService | null {
    if (!this.tokenService) {
      this.tokenService = CoreBetterAuthModule.getTokenServiceInstance();
    }
    return this.tokenService;
  }

  /**
   * Try to verify a BetterAuth token if user isn't already on the request.
   * This handles cases where middleware didn't run (e.g., test environments).
   */
  private async verifyToken(request: any): Promise<BetterAuthenticatedUser | null> {
    const tokenService = this.getTokenService();
    if (!tokenService) {
      return null;
    }

    try {
      const { token } = tokenService.extractTokenFromRequest(request);
      if (!token) {
        return null;
      }
      return await tokenService.verifyAndLoadUser(token);
    } catch (error) {
      this.logger.debug(`Token verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Get roles from decorator metadata using Reflect.getMetadata directly
    // This avoids the need for NestJS Reflector which causes DI issues in dynamic modules
    const handlerRoles = Reflect.getMetadata('roles', context.getHandler()) as string[] | undefined;
    const classRoles = Reflect.getMetadata('roles', context.getClass()) as string[] | undefined;

    // Combine handler and class roles (handler takes precedence, like Reflector.getAll)
    const reflectorRoles: (string[] | undefined)[] = [handlerRoles, classRoles];
    const roles: string[] = reflectorRoles[0]
      ? reflectorRoles[1]
        ? [...reflectorRoles[0], ...reflectorRoles[1]]
        : reflectorRoles[0]
      : reflectorRoles[1];

    // Check if locked - always deny
    if (roles && roles.includes(RoleEnum.S_NO_ONE)) {
      throw new UnauthorizedException(ErrorCode.UNAUTHORIZED);
    }

    // If no roles required, or S_EVERYONE is set, allow access without authentication
    if (!roles || !roles.some((value) => !!value) || roles.includes(RoleEnum.S_EVERYONE)) {
      return true;
    }

    // Get request and check for user (set by BetterAuth middleware)
    const request = this.getRequest(context);
    let user = request?.user;

    // If user isn't set (e.g., middleware didn't run in test environment),
    // try to verify the token directly
    if (!user) {
      user = await this.verifyToken(request);
      if (user && request) {
        // Store the verified user on the request for downstream handlers
        request.user = user;
      }
    }

    // Check if user is authenticated
    if (!user) {
      throw new UnauthorizedException(ErrorCode.UNAUTHORIZED);
    }

    // Check S_USER role - any authenticated user is allowed
    if (roles.includes(RoleEnum.S_USER)) {
      return true;
    }

    // Check S_SELF role - user is accessing their own data
    if (roles.includes(RoleEnum.S_SELF)) {
      // Get the target object's ID from params or args
      const targetId = this.getTargetId(context);
      if (targetId && user.id === targetId) {
        return true;
      }
    }

    // Check S_CREATOR role - user created the object
    if (roles.includes(RoleEnum.S_CREATOR)) {
      // This requires the object to have a createdBy field
      // Usually checked in services, but we can't access the object here
      // Let it pass and check in the service/resolver
      this.logger.debug('S_CREATOR check deferred to service layer');
    }

    // Check S_VERIFIED role - user's email is verified
    if (roles.includes(RoleEnum.S_VERIFIED)) {
      if (!user.verified && !user.verifiedAt && !user.emailVerified) {
        throw new ForbiddenException(ErrorCode.ACCESS_DENIED);
      }
      return true;
    }

    // Check if user has required role
    if (user.hasRole?.(roles)) {
      return true;
    }

    // Check if user's roles array includes any of the required roles
    if (user.roles && Array.isArray(user.roles)) {
      const hasRequiredRole = roles.some((role) => user.roles.includes(role));
      if (hasRequiredRole) {
        return true;
      }
    }

    // User doesn't have required role
    throw new ForbiddenException(ErrorCode.ACCESS_DENIED);
  }

  /**
   * Get request from execution context
   * Handles both GraphQL and HTTP contexts
   */
  private getRequest(context: ExecutionContext): any {
    // Try GraphQL context first
    try {
      const gqlContext = GqlExecutionContext.create(context);
      const ctx = gqlContext.getContext();
      if (ctx?.req) {
        return ctx.req;
      }
    } catch {
      // GraphQL context not available
    }

    // Fallback to HTTP context
    return context.switchToHttp().getRequest();
  }

  /**
   * Get target ID from context for S_SELF checks
   */
  private getTargetId(context: ExecutionContext): null | string {
    // Try GraphQL args
    try {
      const gqlContext = GqlExecutionContext.create(context);
      const args = gqlContext.getArgs();
      if (args?.id) {
        return args.id;
      }
    } catch {
      // GraphQL context not available
    }

    // Try HTTP params
    try {
      const request = context.switchToHttp().getRequest();
      if (request?.params?.id) {
        return request.params.id;
      }
    } catch {
      // HTTP context not available
    }

    return null;
  }
}
