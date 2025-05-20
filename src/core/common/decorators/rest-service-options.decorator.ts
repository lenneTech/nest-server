import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import { currentUserDec } from '../helpers/decorator.helper';
import { ServiceOptions } from '../interfaces/service-options.interface';

/**
 * Get standard ServiceOptions for REST-Requests
 *
 * Includes following properties of ServiceOptions:
 *  - currentUser
 *  - language
 *
 *  param data is set to null, because it is not used in this decorator
 */
export const RESTServiceOptions = createParamDecorator((data: unknown, ctx: ExecutionContext): ServiceOptions => {
  if (ctx?.getType() !== 'http') {
    console.warn('[RESTServiceOptions] Not an HTTP context:', ctx?.getType());
    return { currentUser: null };
  }

  const request = ctx.switchToHttp()?.getRequest();
  const language = request?.headers?.['accept-language'];
  return {
    currentUser: currentUserDec(null, ctx),
    language,
  };
});
