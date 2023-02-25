import { createParamDecorator } from '@nestjs/common';
import { graphqlPopulateDec } from '../helpers/decorator.helper';

/**
 * Get Mongoose populate configuration for result type of GraphQL request
 *
 * gqlPath (string, default: name of the resolver method):
 * Dot separated path to select specific fields in GraphQL request
 * (usually name of the query or mutation (resolver) method, e.g 'getUser')
 *
 * ignoreSelections (boolean, default: true):
 * Whether to ignore selections in population options
 * to avoid problems with missing properties (if not requested) in the checkSecurity method of models
 */
export const GraphQLPopulate = createParamDecorator(graphqlPopulateDec);
