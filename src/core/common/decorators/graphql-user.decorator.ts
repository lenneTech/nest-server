import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';

/**
 * User decorator for GraphQL request
 */
export const GraphQLUser = createParamDecorator((data: unknown, ctx: ExecutionContext) => {
  const context = GqlExecutionContext.create(ctx)?.getContext();
  return context?.user || context?.req?.user;
});
