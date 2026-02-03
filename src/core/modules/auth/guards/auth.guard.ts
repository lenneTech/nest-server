import { CanActivate, ExecutionContext, Logger, mixin, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { AuthModuleOptions, Type } from '@nestjs/passport';
import { defaultOptions } from '@nestjs/passport/dist/options';
import { memoize } from '@nestjs/passport/dist/utils/memoize.util';
import passport = require('passport');

import { BetterAuthTokenService } from '../../better-auth/better-auth-token.service';
import { BetterAuthenticatedUser } from '../../better-auth/better-auth.types';
import { CoreBetterAuthService } from '../../better-auth/core-better-auth.service';
import { AuthGuardStrategy } from '../auth-guard-strategy.enum';
import { ExpiredRefreshTokenException } from '../exceptions/expired-refresh-token.exception';
import { ExpiredTokenException } from '../exceptions/expired-token.exception';
import { InvalidTokenException } from '../exceptions/invalid-token.exception';

/**
 * Missing strategy error
 */
const NO_STRATEGY_ERROR =
  'In order to use "defaultStrategy", please, ensure to import PassportModule in each ' +
  "place where AuthGuard() is being used. Otherwise, passport won't work correctly.";

/**
 * Interface for auth guard
 */
export type IAuthGuard = CanActivate & {
  handleRequest<TUser = any>(err: Error | null, user: any, info: any, context: ExecutionContext): TUser;
};

/**
 * Create passport context
 * @param request
 * @param response
 */
const createPassportContext =
  (request: any, response: any) => (type: any, options: any, callback: (...params: any[]) => any) =>
    new Promise((resolve, reject) =>
      passport.authenticate(type, options, (err: any, user: any, info: any) => {
        try {
          request.authInfo = info;
          return resolve(callback(err, user, info));
        } catch (err) {
          reject(err);
        }
      })(request, response, (err: any) => (err ? reject(err) : resolve(undefined))),
    );

/**
 * Extension of AuthGuard to get context in handleRequest method
 * See: https://github.com/nestjs/passport/blob/master/lib/auth.guard.ts
 *
 * MULTI-TOKEN SUPPORT:
 * This guard supports multiple authentication strategies:
 * 1. JWT (Legacy Auth) - Uses Passport JWT strategy
 * 2. JWT_REFRESH (Legacy Auth) - Uses Passport JWT refresh strategy
 * 3. BETTER_AUTH (IAM) - Uses BetterAuthTokenService directly (no Passport)
 *
 * For BETTER_AUTH strategy:
 * - First checks if user is already authenticated via middleware (_authenticatedViaBetterAuth)
 * - If not, validates the token via BetterAuthTokenService (JWT or session token)
 * - Loads the full user from MongoDB with hasRole() capability
 *
 * Can be removed when pull request is merged:
 * https://github.com/nestjs/passport/pull/66
 */
function createAuthGuard(type?: AuthGuardStrategy | string | string[]): Type<IAuthGuard> {
  class MixinAuthGuard<TUser = any> {
    private readonly logger = new Logger('AuthGuard');
    private betterAuthService: CoreBetterAuthService | null = null;
    private tokenService: BetterAuthTokenService | null = null;
    private servicesResolved = false;

    /**
     * Integrate options
     */
    constructor(
      @Optional() protected readonly options?: AuthModuleOptions,
      @Optional() private readonly moduleRef?: ModuleRef,
    ) {
      this.options = this.options || {};
      if (!type && !this.options.defaultStrategy) {
        this.logger.error(NO_STRATEGY_ERROR);
      }
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
        // BetterAuth not available - that's fine for JWT-only setups
      }

      try {
        this.tokenService = this.moduleRef.get(BetterAuthTokenService, { strict: false });
      } catch {
        // BetterAuthTokenService not available
      }

      this.servicesResolved = true;
    }

    /**
     * Check if user can activate the route
     */
    async canActivate(context: ExecutionContext): Promise<boolean> {
      const args = context.getArgs();
      if (args.length > 0 && args[args.length - 1]?.operation?.operation === 'subscription') {
        return true;
      }

      const options = { ...defaultOptions, ...this.options };
      const request = this.getRequest(context);

      // Check if user is already authenticated via Better-Auth middleware
      // Only skip Passport for Better-Auth users (marked with _authenticatedViaBetterAuth)
      // This ensures JWT_REFRESH guard still validates refresh tokens properly
      const existingUser = request?.[options.property || defaultOptions.property];
      if (existingUser && existingUser._authenticatedViaBetterAuth === true) {
        // User is authenticated via Better-Auth - skip Passport authentication
        // Validate through handleRequest to ensure role checks work
        const validatedUser = this.handleRequest(null, existingUser, null, context);
        request[options.property || defaultOptions.property] = validatedUser;
        return true;
      }

      // For BETTER_AUTH strategy, use BetterAuthTokenService directly (no Passport)
      if (type === AuthGuardStrategy.BETTER_AUTH) {
        return this.handleBetterAuthStrategy(context, request, options);
      }

      // Proceed with Passport authentication for other strategies
      const response = context?.switchToHttp()?.getResponse();
      const passportFn = createPassportContext(request, response);
      const user = await passportFn(
        type || this.options?.defaultStrategy,
        options,
        (err: any, currentUser: any, info: any) => this.handleRequest(err, currentUser, info, context),
      );
      request[options.property || defaultOptions.property] = user;
      return true;
    }

    /**
     * Handle BETTER_AUTH strategy authentication.
     * Validates tokens via BetterAuthTokenService without using Passport.
     */
    private async handleBetterAuthStrategy(
      context: ExecutionContext,
      request: any,
      options: AuthModuleOptions,
    ): Promise<boolean> {
      // Resolve services lazily
      this.resolveServices();

      if (!this.betterAuthService?.isEnabled()) {
        this.logger.warn('BETTER_AUTH strategy used but BetterAuth is not enabled');
        throw new InvalidTokenException();
      }

      // Try to validate token via BetterAuthTokenService
      const user = await this.verifyBetterAuthToken(request);

      if (!user) {
        throw new InvalidTokenException();
      }

      // Validate through handleRequest and set user on request
      const validatedUser = this.handleRequest(null, user, null, context);
      request[options.property || defaultOptions.property] = validatedUser;
      return true;
    }

    /**
     * Verify BetterAuth token (JWT or session) and load the corresponding user.
     *
     * Delegates to BetterAuthTokenService for token verification and user loading.
     *
     * @param request - HTTP request object
     * @returns User object if verification succeeds, null otherwise
     */
    private async verifyBetterAuthToken(request: any): Promise<BetterAuthenticatedUser | null> {
      if (!this.tokenService) {
        return null;
      }

      try {
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
     * Prepare request
     */
    getRequest<T = any>(context: ExecutionContext): T {
      // Try to get request GraphQL context
      try {
        const ctx = GqlExecutionContext.create(context)?.getContext();
        if (ctx?.req) {
          return ctx.req;
        }
      } catch {
        // GraphQL context not available
      }

      // Else return HTTP request
      return context && context.switchToHttp() ? context.switchToHttp().getRequest() : null;
    }

    /**
     * Login for session handling
     */
    async logIn<TRequest extends { logIn: (...params: any[]) => any } = any>(request: TRequest) {
      const user = request[this.options?.property || defaultOptions.property];
      await new Promise<void>((resolve, reject) => request.logIn(user, (err: any) => (err ? reject(err) : resolve())));
    }

    /**
     * Process request
     */
    handleRequest(err: Error | null, user: any, info: any, _context: ExecutionContext): TUser {
      if (err) {
        throw new InvalidTokenException();
      }
      if (!user) {
        if (info?.name === 'TokenExpiredError') {
          if (type === AuthGuardStrategy.JWT_REFRESH) {
            throw new ExpiredRefreshTokenException();
          } else {
            throw new ExpiredTokenException();
          }
        }
        throw new InvalidTokenException();
      }
      return user;
    }
  }

  const guard = mixin<MixinAuthGuard>(MixinAuthGuard);
  return guard;
}

/**
 * Export AuthGuard
 */
export const AuthGuard: (type?: AuthGuardStrategy | string | string[]) => Type<IAuthGuard> = memoize(createAuthGuard);
