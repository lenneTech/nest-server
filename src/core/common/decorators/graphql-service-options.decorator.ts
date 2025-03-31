import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import { currentUserDec, graphqlPopulateDec } from '../helpers/decorator.helper';
import { ServiceOptions } from '../interfaces/service-options.interface';

/**
 * Get standard ServiceOptions for GraphQL-Requests
 *
 * Includes following properties of ServiceOptions:
 *  - currentUser
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
    return {
      currentUser: currentUserDec(null, ctx),
      populate: graphqlPopulateDec(data, ctx),
    };
  },
);
