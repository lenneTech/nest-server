import { Blob } from 'buffer';
import util = require('util');
import { INestApplication } from '@nestjs/common';
import { createClient } from 'graphql-ws';
import { jsonToGraphQLQuery } from 'json-to-graphql-query';
import { Types } from 'mongoose';
import supertest = require('supertest');
import ws = require('ws');
import { getStringIds } from '../core/common/helpers/db.helper';

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

  /**
   * GraphQL variables with variable name as key and Type as value
   */
  variables?: Record<string, string>;
}

export interface TestGraphQLAttachment {
  file: Blob | Buffer | ReadableStream | string | boolean | number;
  options?: string | { filename?: string | undefined; contentType?: string | undefined };
}

export interface TestGraphQLVariable {
  value: string | string[] | TestGraphQLAttachment | TestGraphQLAttachment[] | any;
  type: 'field' | 'attachment';
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
   * Output information in the console
   */
  log?: boolean;

  /**
   * Log error when status of response >= 400
   */
  logError?: boolean;

  /**
   * Whether to prepare arguments (like dates)
   */
  prepareArguments?: boolean;

  /**
   * Status Code = 400
   */
  statusCode?: number;

  /**
   * Token of user who is logged in
   */
  token?: string;

  /**
   * GraphQL variables
   */
  variables?: Record<string, TestGraphQLVariable>;
}

/**
 * Options for rest requests
 */
export interface TestRestOptions {
  attachments?: Record<string, string>;
  log?: boolean;
  logError?: boolean;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  payload?: any;
  statusCode?: number;
  token?: string;
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
   * Download file from URL
   * @return Superagent response with additional data field containing the content of the file
   */
  download(url: string, token?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const request = supertest((this.app as INestApplication).getHttpServer()).get(url);
      if (token) {
        request.set('Authorization', `bearer ${token}`);
      }
      let data = '';
      request
        .buffer()
        .parse((res: any, callback) => {
          res.setEncoding('binary');
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('error', reject);
          res.on('end', (err) => {
            err ? reject(err) : callback(null, null);
          });
        })
        .end((err, res: any) => {
          (res as any & { data: string }).data = Buffer.from(data, 'binary').toString();
          err ? reject(err) : resolve(res as any);
        });
    });
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
      prepareArguments: true,
      ...options,
    };

    // Init vars
    const { token, statusCode, log, logError, variables } = config;

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
        graphql,
      ) as TestGraphQLConfig;

      // Init request
      const queryObj = {};

      // Set request type
      queryObj[graphql.type] = {};

      // Set variables
      if (graphql.variables) {
        queryObj[graphql.type]['__variables'] = graphql.variables;
      }

      // Set request name and fields
      queryObj[graphql.type][graphql.name] = this.prepareFields(graphql.fields) || {};

      // Set arguments
      if (graphql.arguments) {
        queryObj[graphql.type][graphql.name].__args = config.prepareArguments
          ? this.prepareArguments(graphql.arguments)
          : graphql.arguments;
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
          const regExpStr = `(${key}: )\\"([_A-Z][_0-9A-Z]*)\\"`;
          const regExp = new RegExp(regExpStr, 'g');
          query = query.replace(regExp, '$1$2');
        }
      } else {
        query = query.replace(/([_A-Za-z][_0-9A-Za-z]*:\s)\"([_A-Z][_0-9A-Z]*)\"/g, '$1$2');
      }
    }

    // Request configuration
    const requestConfig: any = {
      method: 'POST',
      url: '/graphql',
      payload: { query },
    };

    // Token
    if (token) {
      requestConfig.headers = { authorization: `Bearer ${token}` };
    }

    // Get response
    const response = await this.getResponse(token, requestConfig, statusCode, log, logError, variables);

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
      method: options?.attachments ? 'POST' : 'GET',
      ...options,
    };

    // Init vars
    const { token, statusCode, log, logError, attachments } = config;

    // Request configuration
    const requestConfig: any = {
      method: config.method,
      url,
    };
    if (config.payload) {
      requestConfig.payload = config.payload;
    }

    // Process response
    const response = await this.getResponse(token, requestConfig, statusCode, log, logError, null, attachments);
    let result = response.text;
    if (response.text === '') {
      return null;
    }
    try {
      result = JSON.parse(response.text);
    } catch (e) {
      // nothing to do
    }

    // Return result
    return result;
  }

  /**
   * Prepare arguments
   */
  prepareArguments(args: any, objects?: WeakMap<any, any>) {
    if (!args) {
      return args;
    }
    if (args instanceof Date) {
      return args.toISOString();
    }
    if (args instanceof Types.ObjectId) {
      return getStringIds(args);
    }
    if (!objects) {
      objects = new WeakMap<any, any>();
    }
    if (typeof args === 'object' && objects.get(args)) {
      return objects.get(args);
    }
    if (Array.isArray(args)) {
      objects.set(args, args);
      return args.map(item => this.prepareArguments(item, objects));
    }
    if (typeof args === 'object') {
      objects.set(args, args);
      for (const [key, value] of Object.entries(args)) {
        args[key] = this.prepareArguments(value, objects);
      }
      return args;
    }
    return args;
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
    requestConfig: any,
    statusCode: number,
    log: boolean,
    logError: boolean,
    variables?: Record<string, TestGraphQLVariable>,
    attachments?: Record<string, string>,
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
    //     console.info(response);
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
      request.set('Authorization', `bearer ${token}`);
    }

    // Process variables (incl. attachments for GraphQL)
    if (variables) {
      request = this.processVariables(request, variables, (requestConfig.payload as any)?.query);
    }

    // Process REST attachments
    if (attachments) {
      for (const [key, value] of Object.entries(attachments)) {
        request.attach(key, value);
      }
    }

    // Response
    if (log) {
      console.info(requestConfig);
    }
    const response = await (variables || attachments ? request : request.send(requestConfig.payload));
    return this.processResponse(response, statusCode, log, logError);
  }

  /**
   * Process GraphQL variables
   */
  processVariables(request: any, variables: Record<string, TestGraphQLVariable>, query: string | object) {
    // Check and optimize parameters
    if (!variables) {
      return request;
    }
    if (typeof query === 'object') {
      query = JSON.stringify(query).replace(/"/g, '');
    }

    // Create map
    const mapArray: { key: string; type: 'attachment' | 'field'; value: any; index?: number }[] = [];
    for (const [key, item] of Object.entries(variables)) {
      if (item.type === 'attachment' && Array.isArray(item.value)) {
        item.value.forEach((element, index) => {
          mapArray.push({ key, type: 'attachment', value: element, index });
        });
      } else {
        mapArray.push({ key, type: item.type, value: item.value });
      }
    }
    const map = {};
    mapArray.forEach((item, index) => {
      map[index] = [`variables.${item.key}${'index' in item ? `.${item.index}` : ''}`];
    });

    // Add operations
    request.field('operations', JSON.stringify({ query })).field('map', JSON.stringify(map));

    // Add variables as attachment or field
    mapArray.forEach((variable, i) => {
      if (variable.type === 'attachment') {
        // See https://stackoverflow.com/questions/74581070/apollo-client-this-operation-has-been-blocked-as-a-potential-cross-site-request
        request.set('Apollo-Require-Preflight', 'true');
        if (typeof variable.value === 'object' && variable.value.file) {
          request.attach(`${i}`, variable.value.file, variable.value.options);
        } else {
          request.attach(`${i}`, variable.value);
        }
      } else {
        request.field(`${i}`, variable.value);
      }
    });

    // Return processed request
    return request;
  }

  /**
   * Process GraphQL response
   */
  processResponse(response, statusCode, log, logError) {
    // Log response
    if (log) {
      console.info('Response', JSON.stringify(response, null, 2));
    }

    // Log error
    if (logError && response.statusCode !== statusCode && response.statusCode >= 400) {
      if (response && response.error && response.error.text) {
        const errors = JSON.parse(response.error.text).errors;
        for (const error of errors) {
          console.error(util.inspect(error, false, null, true));
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
      throw new Error('Missing subscriptionUrl in TestHelper: new TestHelper(app, \'ws://localhost:3030/graphql\')');
    }

    // Prepare subscription
    let connectionParams;
    if (options?.token) {
      connectionParams = { Authorization: `Bearer ${options?.token}` };
    }

    // Init client
    if (options.log) {
      console.info('Subscription query', JSON.stringify(query, null, 2));
    }
    const client = createClient({ url: this.subscriptionUrl, connectionParams, webSocketImpl: ws });
    const messages: any[] = [];
    let unsubscribe: () => void;
    const onNext = (message) => {
      if (options.log) {
        console.info('Subscription message', JSON.stringify(message, null, 2));
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
        },
      );
    });

    // Return subscribed messages
    return messages;
  }
}
