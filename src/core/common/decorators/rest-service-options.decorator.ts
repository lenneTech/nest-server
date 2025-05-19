import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import { currentUserDec } from '../helpers/decorator.helper';
import { ServiceOptions } from '../interfaces/service-options.interface';

/**
 * Get standard ServiceOptions for REST-Requests
 *
 * Includes following properties of ServiceOptions:
 *  - currentUser
 *  - language
 */
export const RESTServiceOptions = createParamDecorator((data: unknown, ctx: ExecutionContext): ServiceOptions => {
  if (ctx.getType() !== 'http') {
    console.warn('[RESTServiceOptions] Not an HTTP context:', ctx.getType());
    return { currentUser: null };
  }

  try {
    const request = ctx.switchToHttp().getRequest();
    const language = request?.headers?.['accept-language'];

    return {
      currentUser: currentUserDec(null, ctx),
      language,
    };
  } catch (e) {
    console.warn('[RESTServiceOptions] Error accessing request', e);
    return { currentUser: null };
  }
});
