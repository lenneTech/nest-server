import { jsonToGraphQLQuery } from 'json-to-graphql-query';

/**
 * GraphQL request type
 */
export enum GraphQLType {
  QUERY = 'query',
  MUTATION = 'mutation',
  SUBSCRIPTION = 'subscription',
}

/**
 * GraphQL fields
 */
export interface FieldObject {
  [key: string]: boolean | string[] | FieldObject;
}

/**
 * GraphQL fields
 */
export type Fields = string | string[] | FieldObject;

/**
 * GraphQL request config
 */
export interface GraphQLConfig {

  /**
   * GraphQL arguments
   * https://graphql.org/learn/queries/#arguments
   */
  arguments?: { [key: string]: any };

  /**
   * GraphQL fields
   * https://graphql.org/learn/queries/#fields
   */
  fields?: Fields;

  /**
   * Name of the request type
   */
  name?: string;

  /**
   * GraphQL request type
   * https://graphql.org/learn/queries
   */
  type?: GraphQLType;

}

/**
 * Test helper
 */
export class TestHelper {
  app: any;

  /**
   * Constructor
   */
  constructor(app: any) {
    this.app = app;
  }

  /**
   * GraphQL request
   * @param graphql
   * @param statusCode
   */
  async graphQl(graphql: string | GraphQLConfig = {}, statusCode: number = 200): Promise<any> {

    // Init
    let query: string = '';

    // Convert string to GraphQLConfig
    if ((typeof graphql === 'string' || graphql instanceof String) && /^[a-zA-Z]+$/.test(graphql as string)) {

      // Use input as query
      query = graphql as string;
    } else {

      // Use input as name
      if (typeof graphql === 'string' || graphql instanceof String) {
        graphql = { name: graphql } as any;
      }

      // Prepare config
      graphql = Object.assign({ arguments: null, fields: ['id'], name: null, type: GraphQLType.QUERY }, graphql) as GraphQLConfig;

      // Init request
      const queryObj = {};

      // Set request type
      queryObj[graphql.type] = {};

      // Set request name and fields
      queryObj[graphql.type][graphql.name] = this.prepareFields(graphql.fields) || {};

      // Set arguments
      if (graphql.arguments) {
        queryObj[graphql.type][graphql.name].__args = graphql.arguments;
      }

      // Create request payload query
      query = jsonToGraphQLQuery(queryObj, { pretty: true });
    }

    // Response
    const response = await this.app.inject({
      method: 'POST',
      url: '/graphql',
      payload: { query },
    });

    // Check response
    expect(response.statusCode).toBe(statusCode);
    expect(response.headers['content-type']).toBe('application/json');

    // return data
    return JSON.parse(response.body).data ?
      JSON.parse(response.body).data[(graphql as GraphQLConfig).name] : JSON.parse(response.body);
  }

  /**
   * Prepare GraphQL fields for request
   * @param fields
   */
  prepareFields(fields: any) {
    const result = {};
    if (typeof fields === 'string') {
      result[fields] = true;
    } else if (Array.isArray(fields)) {
      for (const key of fields) {
        result[key] = true;
      }
    } else if (typeof fields === 'object') {
      for (const [key, val] of Object.entries(fields)) {
        result[key] = this.prepareFields(val);
      }
    } else {
      return fields;
    }
    return result;
  }
}
