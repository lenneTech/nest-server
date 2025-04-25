import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';

import { currentUserDec, graphqlPopulateDec } from '../helpers/decorator.helper';
import { ServiceOptions } from '../interfaces/service-options.interface';

/**
 * Get standard ServiceOptions for GraphQL-Requests
 *
 * Includes following properties of ServiceOptions:
 *  - currentUser
 *  - language
 *  - populate
 *
 * Configuration via Decorator data:
 *
 * gqlPath (string, default: name of the resolver method):
 * Dot separated path to select specific fields in GraphQL request
 * (usually name of the query or mutation (resolver) method, e.g 'getUser')
 *
 * ignoreSelections (boolean, default: true):
 * Whether to ignore selections in population options
 * to avoid problems with missing properties (if not requested) in the checkSecurity method of models
 */
export const GraphQLServiceOptions = createParamDecorator(
  (data: { gqlPath?: string; ignoreSelections?: boolean }, ctx: ExecutionContext): ServiceOptions => {
    const gqlContext = GqlExecutionContext.create(ctx);
    const request = gqlContext.getContext().req;

    const language = request?.headers?.['accept-language'];

    return {
      currentUser: currentUserDec(null, ctx),
      language,
      populate: graphqlPopulateDec(data, ctx),
    };
  },
);
