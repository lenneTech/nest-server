import { INestApplication } from '@nestjs/common';
import { FastifyInstance, HTTPInjectOptions } from 'fastify';
import { jsonToGraphQLQuery } from 'json-to-graphql-query';
import * as supertest from 'supertest';

/**
 * GraphQL request type
 */
export enum TestGraphQLType {
  QUERY = 'query',
  MUTATION = 'mutation',
  SUBSCRIPTION = 'subscription',
}

/**
 * GraphQL fields
 */
export interface TestFieldObject {
  [key: string]: boolean | string[] | TestFieldObject;
}

/**
 * GraphQL fields
 */
export type TestFields = string | string[] | TestFieldObject;

/**
 * GraphQL request config
 */
export interface TestGraphQLConfig {
  /**
   * GraphQL arguments
   * https://graphql.org/learn/queries/#arguments
   */
  arguments?: { [key: string]: any };

  /**
   * GraphQL fields
   * https://graphql.org/learn/queries/#fields
   */
  fields?: TestFields | TestFields[];

  /**
   * Name of the request type
   */
  name?: string;

  /**
   * GraphQL request type
   * https://graphql.org/learn/queries
   */
  type?: TestGraphQLType;
}

/**
 * Options for graphql requests
 */
export interface TestGraphQLOptions {
  log?: boolean;
  statusCode?: number;
  token?: string;
}

/**
 * Test helper
 */
export class TestHelper {
  app: FastifyInstance | INestApplication;

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
  async graphQl(graphql: string | TestGraphQLConfig, options: TestGraphQLOptions = {}): Promise<any> {
    // Default options
    options = Object.assign(
      {
        token: null,
        statusCode: 200,
        log: false,
      },
      options
    );

    // Init vars
    const { token, statusCode, log } = options;

    // Init
    let query = '';

    // Convert string to TestGraphQLConfig
    if ((typeof graphql === 'string' || graphql instanceof String) && /^[a-zA-Z]+$/.test(graphql as string)) {
      // Use input as query
      query = graphql as string;
    } else {
      // Use input as name
      if (typeof graphql === 'string' || graphql instanceof String) {
        graphql = { name: graphql } as any;
      }

      // Prepare config
      graphql = Object.assign(
        {
          arguments: null,
          fields: ['id'],
          name: null,
          type: TestGraphQLType.QUERY,
        },
        graphql
      ) as TestGraphQLConfig;

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

    // Request configuration
    const requestConfig: HTTPInjectOptions = {
      method: 'POST',
      url: '/graphql',
      payload: { query },
    };

    // Token
    if (token) {
      requestConfig.headers = { authorization: `Bearer ${token}` };
    }

    // Init response
    let response: any;

    // Response of fastify
    if ((this.app as FastifyInstance).inject) {
      // Get response
      response = await (this.app as FastifyInstance).inject(requestConfig);

      // Log response
      if (log) {
        console.log(response);
      }

      // Check data
      expect(response.statusCode).toBe(statusCode);
      expect(response.headers['content-type']).toBe('application/json');

      // return data
      return JSON.parse(response.payload).data
        ? JSON.parse(response.payload).data[(graphql as TestGraphQLConfig).name]
        : JSON.parse(response.payload);
    }

    // Express request
    let request = supertest((this.app as INestApplication).getHttpServer()).post(requestConfig.url as string);
    if (token) {
      request = request.set('Authorization', 'bearer ' + token);
    }

    // Response
    response = await request.send(requestConfig.payload);

    // Log response
    if (log) {
      console.log(response);
    }

    // Check data
    expect(response.statusCode).toBe(statusCode);
    expect(response.headers['content-type']).toMatch('application/json');

    // return data
    return response.body.data ? response.body.data[(graphql as TestGraphQLConfig).name] : response.body;
  }

  /**
   * Prepare GraphQL fields for request
   * @param fields
   */
  prepareFields(fields: any) {
    const result = {};

    // Process string
    if (typeof fields === 'string') {
      result[fields] = true;

      // Process array
    } else if (Array.isArray(fields)) {
      for (const item of fields) {
        // Process string array
        if (typeof item === 'string') {
          result[item] = true;

          // Process nested array
        } else if (Array.isArray(item)) {
          Object.assign(result, this.prepareFields(item));

          // Process object array
        } else if (typeof item === 'object') {
          for (const [key, val] of Object.entries(item)) {
            result[key] = this.prepareFields(val);
          }
        }
      }

      // Process object
    } else if (typeof fields === 'object') {
      for (const [key, val] of Object.entries(fields)) {
        result[key] = this.prepareFields(val);
      }

      // Process other fields
    } else {
      return fields;
    }

    // Return result
    return result;
  }
}
