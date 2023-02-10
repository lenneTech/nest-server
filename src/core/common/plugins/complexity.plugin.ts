import { GraphQLSchemaHost } from '@nestjs/graphql';
import { Plugin } from '@nestjs/apollo';
import { ApolloServerPlugin, GraphQLRequestListener } from 'apollo-server-plugin-base';
import { GraphQLError } from 'graphql';
import { fieldExtensionsEstimator, getComplexity, simpleEstimator } from 'graphql-query-complexity';
import { ConfigService } from '../services/config.service';

@Plugin()
export class ComplexityPlugin implements ApolloServerPlugin {
  constructor(private gqlSchemaHost: GraphQLSchemaHost, private configService: ConfigService) {}

  async requestDidStart(): Promise<GraphQLRequestListener> {
    const maxComplexity = this.configService.getFastButReadOnly('graphQl.maxComplexity', 1000);
    const { schema } = this.gqlSchemaHost;

    return {
      async didResolveOperation({ request, document }) {
        const complexity = getComplexity({
          schema,
          operationName: request.operationName,
          query: document,
          variables: request.variables,
          estimators: [fieldExtensionsEstimator(), simpleEstimator({ defaultComplexity: 1 })],
        });
        if (complexity > maxComplexity) {
          throw new GraphQLError(`Query is too complex: ${complexity}. Maximum allowed complexity: ${maxComplexity}`);
        }
      },
    };
  }
}
