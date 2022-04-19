import { GraphQLResolveInfo } from 'graphql';

/**
 * Resolve selector to get requested fields from GraphQL resolve info
 */
export interface ResolveSelector {
  info: GraphQLResolveInfo;
  select?: string;
}
