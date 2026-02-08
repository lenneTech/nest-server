import {
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { firstValueFrom, isObservable } from 'rxjs';

import { RoleEnum } from '../../../common/enums/role.enum';
import { BetterAuthTokenService } from '../../better-auth/better-auth-token.service';
import { BetterAuthenticatedUser } from '../../better-auth/better-auth.types';
import { CoreBetterAuthService } from '../../better-auth/core-better-auth.service';
import { ErrorCode } from '../../error-code';
import { AuthGuardStrategy } from '../auth-guard-strategy.enum';
import { ExpiredTokenException } from '../exceptions/expired-token.exception';
import { InvalidTokenException } from '../exceptions/invalid-token.exception';
import { AuthGuard } from './auth.guard';

/**
 * Role guard
 *
 * The RoleGuard is activated by the Role decorator. It checks whether the current user has at least one of the
 * specified roles or is logged in when the S_USER role is set.
 * If this is not the case, an UnauthorizedException is thrown.
 *
 * MULTI-TOKEN SUPPORT:
 * This guard supports multiple authentication token types:
 * 1. Legacy JWT tokens (Passport JWT strategy)
 * 2. BetterAuth JWT tokens (verified via BetterAuthTokenService)
 * 3. BetterAuth session tokens (verified via database lookup)
 *
 * When Passport JWT validation fails, the guard falls back to BetterAuth verification:
 * - First tries JWT verification if the JWT plugin is enabled
 * - Then tries session token lookup via MongoDB
 *
 * This enables users who sign in via IAM (/iam/sign-in/email) to access all protected endpoints,
 * regardless of whether they use JWT or session-based authentication.
 */
@Injectable()
export class RolesGuard extends AuthGuard(AuthGuardStrategy.JWT) {
  private readonly logger = new Logger(RolesGuard.name);
  private betterAuthService: CoreBetterAuthService | null = null;
  private tokenService: BetterAuthTokenService | null = null;
  private servicesResolved = false;
  private resolvedReflector: null | Reflector = null;

  /**
   * Integrate reflector and moduleRef for lazy service resolution
   *
   * Note: Due to mixin inheritance from AuthGuard, NestJS DI may not inject dependencies correctly
   * because the mixin generates its own design:paramtypes metadata that can override
   * the child class's parameter metadata. Using explicit @Inject() decorators ensures
   * NestJS uses token-based injection rather than positional metadata lookup.
   *
   * The ensureReflector() method provides an additional fallback by lazily resolving
   * Reflector from moduleRef if initial injection fails.
   */
  constructor(
    @Inject(Reflector) protected readonly reflector: Reflector,
    @Optional() @Inject(ModuleRef) private readonly moduleRef?: ModuleRef,
  ) {
    super();
  }

  /**
   * Ensure Reflector is available.
   * Due to mixin inheritance from AuthGuard, NestJS DI may not inject Reflector correctly.
   * This fallback resolves Reflector from moduleRef if not injected.
   */
  private ensureReflector(): Reflector {
    if (this.reflector) {
      return this.reflector;
    }

    if (this.resolvedReflector) {
      return this.resolvedReflector;
    }

    if (this.moduleRef) {
      try {
        this.resolvedReflector = this.moduleRef.get(Reflector, { strict: false });
        return this.resolvedReflector;
      } catch {
        this.logger.error('Failed to resolve Reflector from moduleRef');
      }
    }

    throw new Error('Reflector not available - RolesGuard cannot function without it');
  }

  /**
   * Lazily resolve BetterAuth services
   */
  private resolveServices(): void {
    if (this.servicesResolved || !this.moduleRef) {
      return;
    }

    try {
      this.betterAuthService = this.moduleRef.get(CoreBetterAuthService, { strict: false });
    } catch {
      // BetterAuth not available - that's fine, we'll use Legacy JWT only
    }

    try {
      this.tokenService = this.moduleRef.get(BetterAuthTokenService, { strict: false });
    } catch {
      // BetterAuthTokenService not available
    }

    this.servicesResolved = true;
  }

  /**
   * Override canActivate to add BetterAuth JWT fallback
   *
   * Flow:
   * 1. Check if roles are required - if not, skip authentication entirely
   * 2. Check if user is already authenticated via BetterAuth middleware
   * 3. If BetterAuth is enabled, try BetterAuth token verification first
   * 4. Otherwise, try Passport JWT authentication (Legacy JWT)
   * 5. If Passport fails and BetterAuth is enabled, try BetterAuth as fallback
   *
   * This order ensures IAM-only setups work without requiring JWT strategy registration.
   */
  override async canActivate(context: ExecutionContext): Promise<boolean> {
    // Get roles FIRST to check if authentication is even needed
    const reflectorRoles = this.ensureReflector().getAll<string[][]>('roles', [
      context.getHandler(),
      context.getClass(),
    ]);
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
    // This allows public endpoints (without @Roles decorator or with S_EVERYONE) to work
    if (!roles || !roles.some((value) => !!value) || roles.includes(RoleEnum.S_EVERYONE)) {
      return true;
    }

    // Resolve services lazily (only needed if authentication is required)
    this.resolveServices();

    // Get request and check for existing user (from BetterAuth middleware)
    const request = this.getRequest(context);
    const existingUser = request?.user;

    // If user is already authenticated via BetterAuth middleware, validate roles directly
    if (existingUser && existingUser._authenticatedViaBetterAuth === true) {
      this.handleRequest(null, existingUser, null, context);
      return true;
    }

    // If BetterAuth is enabled, try BetterAuth verification FIRST
    // This allows IAM-only setups to work without JWT strategy
    if (this.betterAuthService?.isEnabled()) {
      const user = await this.verifyBetterAuthTokenFromContext(context);
      if (user) {
        // BetterAuth token is valid - set the user on the request
        if (request) {
          request.user = user;
        }
        // Validate roles
        this.handleRequest(null, user, null, context);
        return true;
      }
    }

    // Try Passport JWT authentication (Legacy JWT)
    try {
      const result = super.canActivate(context);
      return isObservable(result) ? await firstValueFrom(result) : await result;
    } catch (passportError) {
      // Check if this is an "Unknown authentication strategy" error
      // This happens in IAM-only setups where JWT strategy is not registered
      const errorMessage = passportError instanceof Error ? passportError.message : String(passportError);
      const isStrategyError = errorMessage.includes('Unknown authentication strategy');

      // If BetterAuth is enabled but verification failed earlier, or if this is a strategy error
      if (this.betterAuthService?.isEnabled()) {
        // For strategy errors, BetterAuth verification already failed above
        // Rethrow with a more descriptive error
        if (isStrategyError) {
          throw new InvalidTokenException();
        }

        // For other errors (e.g., invalid JWT), try BetterAuth as fallback one more time
        const user = await this.verifyBetterAuthTokenFromContext(context);
        if (user) {
          if (request) {
            request.user = user;
          }
          this.handleRequest(null, user, null, context);
          return true;
        }
      }

      // BetterAuth verification also failed - rethrow original error
      throw passportError;
    }
  }

  /**
   * Verify BetterAuth token (JWT or session) and load the corresponding user.
   *
   * Delegates to BetterAuthTokenService for token extraction and verification.
   * Handles both GraphQL and HTTP contexts.
   *
   * @param context - ExecutionContext to extract request from
   * @returns User object if verification succeeds, null otherwise
   */
  private async verifyBetterAuthTokenFromContext(context: ExecutionContext): Promise<BetterAuthenticatedUser | null> {
    if (!this.tokenService) {
      return null;
    }

    try {
      // Extract request from context (supports both GraphQL and HTTP)
      const request = this.extractRequestFromContext(context);
      if (!request) {
        return null;
      }

      // Extract token from request
      const { token } = this.tokenService.extractTokenFromRequest(request);
      if (!token) {
        return null;
      }

      // Verify token and load user
      return await this.tokenService.verifyAndLoadUser(token);
    } catch (error) {
      this.logger.debug(
        `BetterAuth token verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return null;
    }
  }

  /**
   * Extracts the request object from ExecutionContext.
   * Handles both GraphQL and HTTP contexts.
   *
   * @param context - ExecutionContext
   * @returns Request object with headers and cookies
   */
  private extractRequestFromContext(context: ExecutionContext): null | {
    cookies?: Record<string, string>;
    headers?: Record<string, string | string[] | undefined>;
  } {
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
    try {
      const httpRequest = context.switchToHttp().getRequest();
      if (httpRequest) {
        return httpRequest;
      }
    } catch {
      // HTTP context not available
    }

    return null;
  }

  /**
   * Handle request
   */
  override handleRequest(err: Error | null, user: any, info: any, context: ExecutionContext) {
    // Get roles
    const reflectorRoles = this.ensureReflector().getAll<string[][]>('roles', [
      context.getHandler(),
      context.getClass(),
    ]);
    const roles: string[] = reflectorRoles[0]
      ? reflectorRoles[1]
        ? [...reflectorRoles[0], ...reflectorRoles[1]]
        : reflectorRoles[0]
      : reflectorRoles[1];

    // Check if locked
    if (roles && roles.includes(RoleEnum.S_NO_ONE)) {
      throw new UnauthorizedException(ErrorCode.UNAUTHORIZED);
    }

    // Check roles
    if (!roles || !roles.some((value) => !!value)) {
      return user;
    }

    // Check user and user roles
    if (!user?.hasRole?.(roles)) {
      // Check special user roles (user is logged in or access is free for any)
      if ((user && roles.includes(RoleEnum.S_USER)) || roles.includes(RoleEnum.S_EVERYONE)) {
        return user;
      }

      // If user is missing throw token exception
      if (!user) {
        if (err) {
          throw new InvalidTokenException();
        }
        if (info?.name === 'TokenExpiredError') {
          throw new ExpiredTokenException();
        }
        throw new UnauthorizedException(ErrorCode.UNAUTHORIZED);
      }

      // Requester is not authorized
      throw new ForbiddenException(ErrorCode.ACCESS_DENIED);
    }

    // Everything is ok
    return user;
  }

  /**
   * Integrate request from GraphQL
   */
  getRequest(context: ExecutionContext) {
    const ctx = GqlExecutionContext.create(context);
    // For GraphQL: ctx.getContext() is the GQL context with `.req` property
    // For REST/HTTP: ctx.getContext() returns the `next` function (truthy but without `.req`)
    // Using `?.req ||` ensures we fall back to the HTTP request for REST controllers
    return ctx.getContext()?.req || context.switchToHttp().getRequest();
  }
}
