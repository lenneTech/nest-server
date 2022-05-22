import { INestApplication } from '@nestjs/common';
import { createClient } from 'graphql-ws';
import { jsonToGraphQLQuery } from 'json-to-graphql-query';
import * as LightMyRequest from 'light-my-request';
import * as supertest from 'supertest';
import * as util from 'util';
import * as ws from 'ws';

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
  [key: string]: boolean | (string | TestFieldObject)[] | TestFieldObject;
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
  /**
   * Convert uppercase strings in arguments of query to enums
   * true: convert all, Array with key names (strings): convert special keys only
   */
  convertEnums?: boolean | string[];

  /**
   * Count of subscription messages, specifies how many messages are to be received on subscription
   */
  countOfSubscriptionMessages?: number;

  /**
   * Print console logs
   */
  log?: boolean;

  /**
   * Log error when status of response >= 400
   */
  logError?: boolean;

  /**
   * Status Code = 400
   */
  statusCode?: number;

  /**
   * Token of user who is logged in
   */
  token?: string;
}

/**
 * Options for rest requests
 */
export interface TestRestOptions {
  log?: boolean;
  logError?: boolean;
  statusCode?: number;
  token?: string;
  payload?: any;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
}

/**
 * Test helper
 */
export class TestHelper {
  // app: FastifyInstance | INestApplication;
  app: INestApplication;

  // URL with port and directory to subscription endpoint
  // e.g.: ws://localhost:3030/graphql
  subscriptionUrl: string;

  /**
   * Constructor
   */
  constructor(app: any, subscriptionUrl?: string) {
    this.app = app;
    this.subscriptionUrl = subscriptionUrl;
  }

  /**
   * GraphQL request
   */
  async graphQl(graphql: string | TestGraphQLConfig, options: TestGraphQLOptions = {}): Promise<any> {
    // Default options
    const config = {
      convertEnums: true,
      countOfSubscriptionMessages: 1,
      token: null,
      statusCode: 200,
      log: false,
      logError: false,
      ...options,
    };

    // Init vars
    const { token, statusCode, log, logError } = config;

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
          fields: [],
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

    if ((graphql as TestGraphQLConfig).type === TestGraphQLType.SUBSCRIPTION) {
      return this.getSubscription(graphql as TestGraphQLConfig, query, config);
    }

    // Convert uppercase strings in arguments of query to enums
    if (config.convertEnums) {
      if (Array.isArray(config.convertEnums)) {
        for (const key of Object.values(config.convertEnums)) {
          const regExpStr = '(' + key + ': )\\"([_A-Z][_0-9A-Z]*)\\"';
          const regExp = new RegExp(regExpStr, 'g');
          query = query.replace(regExp, '$1$2');
        }
      } else {
        query = query.replace(/([_A-Za-z][_0-9A-Za-z]*:\s)\"([_A-Z][_0-9A-Z]*)\"/g, '$1$2');
      }
    }

    // Request configuration
    const requestConfig: LightMyRequest.InjectOptions = {
      method: 'POST',
      url: '/graphql',
      payload: { query },
    };

    // Token
    if (token) {
      requestConfig.headers = { authorization: `Bearer ${token}` };
    }

    // Get response
    const response = await this.getResponse(token, requestConfig, statusCode, log, logError);

    // Response of fastify
    // if ((this.app as FastifyInstance).inject) {
    //   // Check data
    //   expect(response.headers['content-type']).toBe('application/json');
    //
    //   // return data
    //   return JSON.parse(response.payload).data
    //     ? JSON.parse(response.payload).data[(graphql as TestGraphQLConfig).name]
    //     : JSON.parse(response.payload);
    // }

    // Check data
    expect(response.headers['content-type']).toMatch('application/json');

    // return data
    return response.body.data ? response.body.data[(graphql as TestGraphQLConfig).name] : response.body;
  }

  /**
   * Send REST request
   */
  async rest(url: string, options: TestRestOptions = {}): Promise<any> {
    // Default options
    const config: TestRestOptions = {
      token: null,
      statusCode: 200,
      log: false,
      logError: false,
      payload: null,
      method: 'GET',
      ...options,
    };

    // Init vars
    const { token, statusCode, log, logError } = config;

    // Request configuration
    const requestConfig: LightMyRequest.InjectOptions = {
      method: config.method,
      url,
    };
    if (config.payload) {
      requestConfig.payload = config.payload;
    }

    // Process response
    const response = await this.getResponse(token, requestConfig, statusCode, log, logError);
    let result = response.text;
    try {
      result = JSON.parse(response.text);
    } catch (e) {
      // nothing to do
    }

    // Return result
    return result;
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

  /**
   * Get response
   */
  protected async getResponse(
    token: string,
    requestConfig: LightMyRequest.InjectOptions,
    statusCode: number,
    log: boolean,
    logError: boolean
  ): Promise<any> {
    // Token
    if (token) {
      requestConfig.headers = { authorization: `Bearer ${token}` };
    }

    // Init response
    // let response: any;

    // // Response of fastify
    // if ((this.app as FastifyInstance).inject) {
    //   // Get response
    //   response = await (this.app as FastifyInstance).inject(requestConfig);
    //
    //   // Log response
    //   if (log) {
    //     console.log(response);
    //   }
    //
    //   // Check data
    //   expect(response.statusCode).toBe(statusCode);
    //
    //   // Return response
    //   return response;
    // }

    // Express request
    const method: string = requestConfig.method.toLowerCase();
    let request = supertest((this.app as INestApplication).getHttpServer())[method](requestConfig.url as string);
    if (token) {
      request = request.set('Authorization', 'bearer ' + token);
    }

    // Response
    const response = await request.send(requestConfig.payload);

    // Log response
    if (log) {
      console.log(JSON.stringify(response, null, 2));
    }

    // Log error
    if (logError && response.statusCode !== statusCode && response.statusCode >= 400) {
      if (response && response.error && response.error.text) {
        const errors = JSON.parse(response.error.text).errors;
        for (const error of errors) {
          console.log(util.inspect(error, false, null, true));
        }
      }
    }

    // Check data
    expect(response.statusCode).toBe(statusCode);

    // Return response
    return response;
  }

  /**
   * Get subscription
   */
  async getSubscription(graphql: TestGraphQLConfig, query: string, options?: TestGraphQLOptions) {
    // Check url
    if (!this.subscriptionUrl) {
      throw new Error("Missing subscriptionUrl in TestHelper: new TestHelper(app, 'ws://localhost:3030/graphql')");
    }

    // Prepare subscription
    let connectionParams;
    if (options?.token) {
      connectionParams = { Authorization: `Bearer ${options?.token}` };
    }

    // Init client
    if (options.log) {
      console.log('Subscription query', JSON.stringify(query, null, 2));
    }
    const client = createClient({ url: this.subscriptionUrl, connectionParams, webSocketImpl: ws });
    const messages: any[] = [];
    let unsubscribe: () => void;
    const onNext = (message) => {
      if (options.log) {
        console.log('Subscription message', JSON.stringify(message, null, 2));
      }
      messages.push(message?.data?.[graphql.name]);
      if (messages.length <= options.countOfSubscriptionMessages) {
        unsubscribe();
      }
    };

    // Subscribe
    await new Promise((resolve, reject) => {
      unsubscribe = client.subscribe(
        { query },
        {
          next: onNext,
          error: reject,
          complete: resolve as any,
        }
      );
    });

    // Return subscribed messages
    return messages;
  }
}
