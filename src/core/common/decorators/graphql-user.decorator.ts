import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';

/**
 * User decorator for GraphQL request
 */
export const GraphQLUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext) => GqlExecutionContext.create(ctx).getContext().user
);
