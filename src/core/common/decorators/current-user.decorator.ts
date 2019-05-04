import { createParamDecorator } from '@nestjs/common';

/**
 * User decorator
 */
export const CurrentUser = createParamDecorator(
  (data, [root, args, ctx, info]) => ctx.user,
);
