import { CanActivate, ExecutionContext, Logger, Optional, mixin } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { AuthModuleOptions, Type } from '@nestjs/passport';
import { defaultOptions } from '@nestjs/passport/dist/options';
import { memoize } from '@nestjs/passport/dist/utils/memoize.util';

import { AuthGuardStrategy } from '../auth-guard-strategy.enum';
import { ExpiredRefreshTokenException } from '../exceptions/expired-refresh-token.exception';
import { ExpiredTokenException } from '../exceptions/expired-token.exception';
import { InvalidTokenException } from '../exceptions/invalid-token.exception';

import passport = require('passport');

/**
 * Missing strategy error
 */
const NO_STRATEGY_ERROR
  = 'In order to use "defaultStrategy", please, ensure to import PassportModule in each '
  + 'place where AuthGuard() is being used. Otherwise, passport won\'t work correctly.';

/**
 * Interface for auth guard
 */
export type IAuthGuard = CanActivate & {
  handleRequest<TUser = any>(err, user, info, context): TUser;
};

/**
 * Create passport context
 * @param request
 * @param response
 */
const createPassportContext = (request, response) => (type, options, callback: (...params) => any) =>
  new Promise((resolve, reject) =>
    passport.authenticate(type, options, (err, user, info) => {
      try {
        request.authInfo = info;
        return resolve(callback(err, user, info));
      } catch (err) {
        reject(err);
      }
    })(request, response, err => (err ? reject(err) : resolve)),
  );

/**
 * Extension of AuthGuard to get context in handleRequest method
 * See: https://github.com/nestjs/passport/blob/master/lib/auth.guard.ts
 *
 * Can be removed when pull request is merged:
 * https://github.com/nestjs/passport/pull/66
 */
function createAuthGuard(type?: string): Type<CanActivate> {
  class MixinAuthGuard<TUser = any> {
    /**
     * Integrate options
     */
    constructor(@Optional() protected readonly options?: AuthModuleOptions) {
      this.options = this.options || {};
      if (!type && !this.options.defaultStrategy) {
        new Logger('AuthGuard').error(NO_STRATEGY_ERROR);
      }
    }

    /**
     * Integrate options
     */
    async canActivate(context: ExecutionContext): Promise<boolean> {
      const args = context.getArgs();
      if (args.length > 0 && args[args.length - 1]?.operation?.operation === 'subscription') {
        return true;
      }

      const options = { ...defaultOptions, ...this.options };
      const response = context?.switchToHttp()?.getResponse();
      const request = this.getRequest(context);
      const passportFn = createPassportContext(request, response);
      const user = await passportFn(type || this.options.defaultStrategy, options, (err, currentUser, info) =>
        this.handleRequest(err, currentUser, info, context),
      );
      request[options.property || defaultOptions.property] = user;
      return true;
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
      } catch (e) {}

      // Else return HTTP request
      return context && context.switchToHttp() ? context.switchToHttp().getRequest() : null;
    }

    /**
     * Login for session handling
     */
    async logIn<TRequest extends { logIn: (...params) => any } = any>(request: TRequest) {
      const user = request[this.options.property || defaultOptions.property];
      await new Promise<void>((resolve, reject) => request.logIn(user, err => (err ? reject(err) : resolve())));
    }

    /**
     * Process request
     */
    // eslint-disable-next-line unused-imports/no-unused-vars
    handleRequest(err, user, info, context): TUser {
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

  const guard = mixin(MixinAuthGuard);
  return guard;
}

/**
 * Export AuthGuard
 */
export const AuthGuard: (type?: AuthGuardStrategy | string | string[]) => Type<IAuthGuard> = memoize(createAuthGuard);
