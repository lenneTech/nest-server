import { ExecutionContext } from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { PopulateOptions } from 'mongoose';

import { getPopulateOptions } from './db.helper';
import { removePropertiesDeep } from './input.helper';

/**
 * Decorator function to get current user for Controller (http context) and Resolver (graphql context)
 */
export function currentUserDec(data, ctx: ExecutionContext) {
  if (ctx.getType<GqlContextType>() === 'graphql') {
    const gqlContext = GqlExecutionContext.create(ctx);
    return gqlContext.getContext().req.user;
  }
  return ctx.switchToHttp().getRequest().user;
}

/**
 * Decorator function to get Mongoose populate configuration for result type of GraphQL request
 *
 * gqlPath (string, default: name of the resolver method):
 * Dot separated path to select specific fields in GraphQL request
 * (usually name of the query or mutation (resolver) method, e.g 'getUser')
 *
 * ignoreSelections (boolean, default: true):
 * Whether to ignore selections in population options
 * to avoid problems with missing properties (if not requested) in the checkSecurity method of models
 */
export function graphqlPopulateDec(
  data: { gqlPath?: string; ignoreSelections?: boolean },
  ctx: ExecutionContext,
): PopulateOptions[] {
  // Check context type
  if (ctx.getType<GqlContextType>() !== 'graphql') {
    return undefined;
  }

  // Init data
  const gqlContext = GqlExecutionContext.create(ctx);
  const { gqlPath, ignoreSelections } = {
    gqlPath: gqlContext.getHandler().name,
    ignoreSelections: true,
    ...data,
  };

  // Get and prepare populate options
  const populateOptions = getPopulateOptions(gqlContext.getInfo(), gqlPath);
  if (ignoreSelections) {
    removePropertiesDeep(populateOptions, ['select']);
  }

  // Return prepared populate options
  return populateOptions;
}
