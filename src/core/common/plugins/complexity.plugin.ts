import { Plugin } from '@nestjs/apollo';
import { GraphQLSchemaHost } from '@nestjs/graphql';
import { ApolloServerPlugin, GraphQLRequestListener } from 'apollo-server-plugin-base';
import { GraphQLError } from 'graphql';
import { fieldExtensionsEstimator, getComplexity, simpleEstimator } from 'graphql-query-complexity';

import { ConfigService } from '../services/config.service';

@Plugin()
export class ComplexityPlugin implements ApolloServerPlugin {
  constructor(
    private gqlSchemaHost: GraphQLSchemaHost,
    private configService: ConfigService,
  ) {}

  async requestDidStart(): Promise<GraphQLRequestListener> {
    const maxComplexity: number = this.configService.getFastButReadOnly('graphQl.maxComplexity');
    const { schema } = this.gqlSchemaHost;

    return {
      async didResolveOperation({ document, request }) {
        const complexity = getComplexity({
          estimators: [fieldExtensionsEstimator(), simpleEstimator({ defaultComplexity: 1 })],
          operationName: request.operationName,
          query: document,
          schema,
          variables: request.variables,
        });
        if (maxComplexity !== undefined && complexity > maxComplexity) {
          throw new GraphQLError(`Query is too complex: ${complexity}. Maximum allowed complexity: ${maxComplexity}`);
        }
      },
    };
  }
}
