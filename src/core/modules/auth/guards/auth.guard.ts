import { CanActivate, ExecutionContext, Logger, mixin, Optional, UnauthorizedException } from '@nestjs/common';
import { AuthModuleOptions, Type } from '@nestjs/passport';
import { defaultOptions } from '@nestjs/passport/dist/options';
import { memoize } from '@nestjs/passport/dist/utils/memoize.util';
import * as passport from 'passport';

/**
 * Missing strategy error
 */
const NO_STRATEGY_ERROR = 'In order to use "defaultStrategy", please, ensure to import PassportModule in each ' +
  'place where AuthGuard() is being used. Otherwise, passport won\'t work correctly.';

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
const createPassportContext = (request, response) => (
  type,
  options,
  callback: Function,
) =>
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
      const options = { ...defaultOptions, ...this.options };
      const [request, response] = [
        this.getRequest(context),
        context.switchToHttp().getResponse(),
      ];
      const passportFn = createPassportContext(request, response);
      const user = await passportFn(
        type || this.options.defaultStrategy,
        options,
        (err, currentUser, info) => this.handleRequest(err, currentUser, info, context),
      );
      request[options.property || defaultOptions.property] = user;
      return true;
    }

    /**
     * Prepare request
     */
    getRequest<T = any>(context: ExecutionContext): T {
      return context && context.switchToHttp() ? context.switchToHttp().getRequest() : null;
    }

    /**
     * Login for session handling
     */
    async logIn<TRequest extends { logIn: Function } = any>(
      request: TRequest,
    ): Promise<void> {
      const user = request[this.options.property || defaultOptions.property];
      await new Promise((resolve, reject) =>
        request.logIn(user, err => (err ? reject(err) : resolve())),
      );
    }

    /**
     * Process request
     */
    handleRequest(err, user, info, context): TUser {
      if (err || !user) {
        throw err || new UnauthorizedException();
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
export const AuthGuard: (type?: string) => Type<IAuthGuard> = memoize(
  createAuthGuard,
);
