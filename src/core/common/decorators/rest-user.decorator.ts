import { createParamDecorator } from '@nestjs/common';

/**
 * User decorator for REST request
 */
export const RESTUser = createParamDecorator((data, req) => {
  return req.user;
});
