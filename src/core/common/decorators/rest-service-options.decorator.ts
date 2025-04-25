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
export const RESTServiceOptions = createParamDecorator((ctx: ExecutionContext): ServiceOptions => {
  const request = ctx.switchToHttp().getRequest();

  const language = request?.headers?.['accept-language'];

  return {
    currentUser: currentUserDec(null, ctx),
    language,
  };
});
