import { ExecutionContext, createParamDecorator } from '@nestjs/common';

/**
 * User decorator for REST request
 */
export const RESTUser = createParamDecorator((data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest();
  return request.user;
});
