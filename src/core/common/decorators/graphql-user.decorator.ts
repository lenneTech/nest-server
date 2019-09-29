import { createParamDecorator } from '@nestjs/common';

/**
 * User decorator for GraphQL request
 */
export const GraphQLUser = createParamDecorator((data, [root, args, ctx, info]) => ctx.req.user);
