import { ExecutionContext, Injectable, Logger, Optional, UnauthorizedException } from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { firstValueFrom, isObservable } from 'rxjs';

import { RoleEnum } from '../../../common/enums/role.enum';
import { BetterAuthService } from '../../better-auth/better-auth.service';
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
 * 2. BetterAuth JWT tokens (verified via BetterAuth service)
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
  private betterAuthService: BetterAuthService | null = null;
  private mongoConnection: Connection | null = null;
  private servicesResolved = false;

  /**
   * Integrate reflector and moduleRef for lazy service resolution
   */
  constructor(
    protected readonly reflector: Reflector,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {
    super();
  }

  /**
   * Lazily resolve BetterAuth service and MongoDB connection
   */
  private resolveServices(): void {
    if (this.servicesResolved || !this.moduleRef) {
      return;
    }

    try {
      this.betterAuthService = this.moduleRef.get(BetterAuthService, { strict: false });
    } catch {
      // BetterAuth not available - that's fine, we'll use Legacy JWT only
    }

    try {
      // Get the Mongoose connection to query users directly
      this.mongoConnection = this.moduleRef.get(getConnectionToken(), { strict: false });
    } catch {
      // MongoDB connection not available
    }

    this.servicesResolved = true;
  }

  /**
   * Override canActivate to add BetterAuth JWT fallback
   *
   * Flow:
   * 1. Try Passport JWT authentication (Legacy JWT)
   * 2. If that fails, try BetterAuth JWT verification
   * 3. If BetterAuth succeeds, load the user and proceed
   */
  override async canActivate(context: ExecutionContext): Promise<boolean> {
    // Resolve services lazily
    this.resolveServices();

    // First, try the parent canActivate (Passport JWT)
    try {
      const result = super.canActivate(context);
      return isObservable(result) ? await firstValueFrom(result) : await result;
    } catch (passportError) {
      // Passport JWT validation failed - try BetterAuth token fallback (JWT or session)
      if (!this.betterAuthService?.isEnabled()) {
        // BetterAuth not available - rethrow original error
        throw passportError;
      }

      // Try to verify the token via BetterAuth (JWT or session token)
      const user = await this.verifyBetterAuthTokenFromContext(context);
      if (!user) {
        // BetterAuth verification also failed - rethrow original Passport error
        throw passportError;
      }

      // BetterAuth token is valid - set the user on the request
      const request = this.getRequest(context);
      if (request) {
        request.user = user;
      }

      // Now call handleRequest with the BetterAuth-authenticated user to check roles
      this.handleRequest(null, user, null, context);

      return true;
    }
  }

  /**
   * Verify BetterAuth token (JWT or session) and load the corresponding user
   *
   * This method tries multiple verification strategies:
   * 1. BetterAuth JWT verification (if JWT plugin is enabled)
   * 2. BetterAuth session token lookup (database lookup)
   *
   * @param context - ExecutionContext to extract request from
   * @returns User object if verification succeeds, null otherwise
   */
  private async verifyBetterAuthTokenFromContext(context: ExecutionContext): Promise<any> {
    if (!this.betterAuthService || !this.mongoConnection) {
      return null;
    }

    try {
      // Get the raw HTTP request from multiple possible sources
      let authHeader: string | undefined;

      // Try GraphQL context first
      try {
        const gqlContext = GqlExecutionContext.create(context);
        const ctx = gqlContext.getContext();
        if (ctx?.req?.headers) {
          authHeader = ctx.req.headers.authorization || ctx.req.headers.Authorization;
        }
      } catch {
        // GraphQL context not available
      }

      // Fallback to HTTP context
      if (!authHeader) {
        try {
          const httpRequest = context.switchToHttp().getRequest();
          if (httpRequest?.headers) {
            authHeader = httpRequest.headers.authorization || httpRequest.headers.Authorization;
          }
        } catch {
          // HTTP context not available
        }
      }

      let token: string | undefined;

      if (authHeader?.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      } else if (authHeader?.startsWith('bearer ')) {
        // Handle lowercase 'bearer' as well
        token = authHeader.substring(7);
      }

      if (!token) {
        return null;
      }

      // Strategy 1: Try JWT verification (if JWT plugin is enabled)
      if (this.betterAuthService.isJwtEnabled()) {
        try {
          const payload = await this.betterAuthService.verifyJwtToken(token);
          if (payload?.sub) {
            const user = await this.loadUserFromPayload(payload);
            if (user) {
              return user;
            }
          }
        } catch {
          // JWT verification failed - try session token next
        }
      }

      // Strategy 2: Try session token lookup (database lookup)
      try {
        const sessionResult = await this.betterAuthService.getSessionByToken(token);
        if (sessionResult?.user) {
          return this.loadUserFromSessionResult(sessionResult.user);
        }
      } catch {
        // Session lookup failed
      }

      return null;
    } catch (error) {
      this.logger.debug(
        `BetterAuth token fallback failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return null;
    }
  }

  /**
   * Load user from JWT payload using direct MongoDB query
   *
   * @param payload - JWT payload with sub (user ID or iamId)
   * @returns User object with hasRole method
   */
  private async loadUserFromPayload(payload: { [key: string]: any; sub: string }): Promise<any> {
    if (!this.mongoConnection) {
      return null;
    }

    try {
      const usersCollection = this.mongoConnection.collection('users');
      let user: any = null;

      // Try to find by MongoDB _id first
      if (Types.ObjectId.isValid(payload.sub)) {
        user = await usersCollection.findOne({ _id: new Types.ObjectId(payload.sub) });
      }

      // If not found, try by iamId
      if (!user) {
        user = await usersCollection.findOne({ iamId: payload.sub });
      }

      if (!user) {
        return null;
      }

      // Convert MongoDB document to user-like object with hasRole method
      const userObject = {
        ...user,
        _authenticatedViaBetterAuth: true,
        // Add hasRole method for role checking
        hasRole: (roles: string[]): boolean => {
          if (!user.roles || !Array.isArray(user.roles)) {
            return false;
          }
          return roles.some((role) => user.roles.includes(role));
        },
        id: user._id?.toString(),
      };

      return userObject;
    } catch (error) {
      this.logger.debug(
        `Failed to load user from payload: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return null;
    }
  }

  /**
   * Load user from session result (from getSessionByToken)
   *
   * @param sessionUser - User object from session lookup
   * @returns User object with hasRole method
   */
  private async loadUserFromSessionResult(sessionUser: any): Promise<any> {
    if (!this.mongoConnection || !sessionUser) {
      return null;
    }

    try {
      const usersCollection = this.mongoConnection.collection('users');

      // The sessionUser might have id (BetterAuth ID) or email
      // We need to find the corresponding user in our users collection
      let user: any = null;

      // Try to find by email (most reliable)
      if (sessionUser.email) {
        user = await usersCollection.findOne({ email: sessionUser.email });
      }

      // If not found by email, try by iamId
      if (!user && sessionUser.id) {
        user = await usersCollection.findOne({ iamId: sessionUser.id });
      }

      // If still not found, try by _id (if the ID looks like a MongoDB ObjectId)
      if (!user && sessionUser.id && Types.ObjectId.isValid(sessionUser.id)) {
        user = await usersCollection.findOne({ _id: new Types.ObjectId(sessionUser.id) });
      }

      if (!user) {
        return null;
      }

      // Convert MongoDB document to user-like object with hasRole method
      const userObject = {
        ...user,
        _authenticatedViaBetterAuth: true,
        // Add hasRole method for role checking
        hasRole: (roles: string[]): boolean => {
          if (!user.roles || !Array.isArray(user.roles)) {
            return false;
          }
          return roles.some((role) => user.roles.includes(role));
        },
        id: user._id?.toString(),
      };

      return userObject;
    } catch (error) {
      this.logger.debug(
        `Failed to load user from session: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return null;
    }
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
        throw new UnauthorizedException('Unauthorized');
      }

      // Requester is not authorized
      throw new UnauthorizedException('Missing role');
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
