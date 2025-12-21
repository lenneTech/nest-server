import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { DynamicModule, Global, MiddlewareConsumer, Module, NestModule, UnauthorizedException } from '@nestjs/common';
import { APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { MongooseModule } from '@nestjs/mongoose';
import { Context } from 'apollo-server-core';
import graphqlUploadExpress = require('graphql-upload/graphqlUploadExpress.js');
import mongoose from 'mongoose';

import { merge } from './core/common/helpers/config.helper';
import { CheckResponseInterceptor } from './core/common/interceptors/check-response.interceptor';
import { CheckSecurityInterceptor } from './core/common/interceptors/check-security.interceptor';
import { IServerOptions } from './core/common/interfaces/server-options.interface';
import { MapAndValidatePipe } from './core/common/pipes/map-and-validate.pipe';
import { ComplexityPlugin } from './core/common/plugins/complexity.plugin';
import { mongooseIdPlugin } from './core/common/plugins/mongoose-id.plugin';
import { ConfigService } from './core/common/services/config.service';
import { EmailService } from './core/common/services/email.service';
import { MailjetService } from './core/common/services/mailjet.service';
import { ModelDocService } from './core/common/services/model-doc.service';
import { TemplateService } from './core/common/services/template.service';
import { BetterAuthUserMapper } from './core/modules/better-auth/better-auth-user.mapper';
import { BetterAuthModule } from './core/modules/better-auth/better-auth.module';
import { BetterAuthService } from './core/modules/better-auth/better-auth.service';
import { CoreHealthCheckModule } from './core/modules/health-check/core-health-check.module';

/**
 * Core module (dynamic)
 *
 * Which includes the following standard modules and services:
 * - MongooseModule
 * - GraphQL
 * - ConfigService
 *
 * and sets the following services as globals:
 * - ConfigService
 * - EmailService
 * - TemplateService
 */
@Global()
@Module({})
export class CoreModule implements NestModule {
  /**
   * Integrate middleware, e.g. GraphQL upload handing for express
   */
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(graphqlUploadExpress()).forRoutes('graphql');
  }

  /**
   * Convert array with key value entries to header object
   * e.g. ['Sec-WebSocket-Version', '13', 'Sec-WebSocket-Key', 'Yu4Lewa60jLk41YXcVrw0w==']
   * => {
   *   'Sec-WebSocket-Version': '13',
   *   'Sec-WebSocket-Key': 'Yu4Lewa60jLk41YXcVrw0w==',
   * }
   */
  static getHeaderFromArray(array): Record<string, string> {
    const result: Record<string, string> = {};
    if (!array.length) {
      return result;
    }
    for (let i = 0; i < array.length; i += 2) {
      const key = array[i];
      result[key] = array[i + 1];
    }
    return result;
  }

  /**
   * Dynamic module initialization
   *
   * @see https://docs.nestjs.com/modules#dynamic-modules
   *
   * ## Signatures
   *
   * ### IAM-Only Signature (Recommended for new projects)
   *
   * ```typescript
   * CoreModule.forRoot(envConfig)
   * ```
   *
   * Use this for new projects that only use BetterAuth (IAM) for authentication.
   * GraphQL Subscription authentication uses BetterAuth JWT tokens.
   *
   * **Requirements:**
   * - Configure `betterAuth` in your config (enabled by default)
   * - Create BetterAuthModule, Resolver, and Controller in your project
   * - Inject BetterAuthUserMapper in UserService
   *
   * ### Legacy + IAM Signature (For existing projects)
   *
   * ```typescript
   * CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(envConfig.jwt), envConfig)
   * ```
   *
   * @deprecated This 3-parameter signature is deprecated for new projects.
   * Use the single-parameter signature `CoreModule.forRoot(envConfig)` instead.
   * Existing projects can continue using this signature during migration.
   *
   * Use this for existing projects that need Legacy Auth for backwards compatibility.
   * Both Legacy Auth and BetterAuth (IAM) can run in parallel.
   *
   * ## Migration Path
   *
   * 1. **Existing projects**: Use the 3-parameter signature, run Legacy + IAM in parallel
   * 2. **Monitor**: Use `betterAuthMigrationStatus` query to track user migration
   * 3. **Disable Legacy**: Set `auth.legacyEndpoints.enabled: false` after all users migrated
   * 4. **New projects**: Use the single-parameter signature with IAM only
   *
   * @see https://github.com/lenneTech/nest-server/blob/develop/.claude/rules/module-deprecation.md
   */
  static forRoot(options: Partial<IServerOptions>): DynamicModule;
  /**
   * @deprecated Use the single-parameter signature `CoreModule.forRoot(envConfig)` for new projects.
   * This 3-parameter signature is for existing projects during migration to IAM.
   */
  static forRoot(AuthService: any, AuthModule: any, options: Partial<IServerOptions>): DynamicModule;
  static forRoot(
    authServiceOrOptions: any,
    authModuleOrUndefined?: any,
    optionsOrUndefined?: Partial<IServerOptions>,
  ): DynamicModule {
    // Detect which signature was used
    const isIamOnlyMode = authModuleOrUndefined === undefined && optionsOrUndefined === undefined;
    const AuthService = isIamOnlyMode ? null : authServiceOrOptions;
    const AuthModule = isIamOnlyMode ? null : authModuleOrUndefined;
    const options: Partial<IServerOptions> = isIamOnlyMode ? authServiceOrOptions : optionsOrUndefined;

    // Process config
    let cors = {};
    if (options?.cookies) {
      cors = {
        credentials: true,
        origin: true,
      };
    }

    // Build GraphQL driver configuration based on auth mode
    const graphQlDriverConfig = isIamOnlyMode
      ? this.buildIamOnlyGraphQlDriver(cors, options)
      : this.buildLegacyGraphQlDriver(AuthService, AuthModule, cors, options);

    const config: IServerOptions = merge(
      {
        env: 'develop',
        graphQl: {
          driver: graphQlDriverConfig,
          enableSubscriptionAuth: true,
        },
        mongoose: {
          options: {
            connectionFactory: (connection) => {
              connection.plugin(mongooseIdPlugin);
              return connection;
            },
          },
          uri: 'mongodb://localhost/nest-server-default',
        },
        port: 3000,
      } as IServerOptions,
      options,
    );

    // Check secrets
    const jwtConfig = config.jwt;
    if (jwtConfig?.secret && jwtConfig.secret && jwtConfig.refresh && jwtConfig.refresh.secret === jwtConfig.secret) {
      console.warn('JWT secret and refresh secret are equal, this can lead to security vulnerabilities!');
    }

    // Set providers
    const providers: any[] = [
      // The ConfigService provides access to the current configuration of the module
      {
        provide: ConfigService,
        useValue: new ConfigService(config),
      },

      // Core Services
      EmailService,
      TemplateService,
      MailjetService,
    ];

    // Add ComplexityPlugin only if not in Vitest (Vitest has dual GraphQL loading issue)
    if (!process.env.VITEST) {
      providers.push(ComplexityPlugin);
    }

    if (config.security?.checkResponseInterceptor ?? true) {
      // Check restrictions for output (models and output objects)
      providers.push({
        provide: APP_INTERCEPTOR,
        useClass: CheckResponseInterceptor,
      });
    }

    if (config.security?.checkSecurityInterceptor ?? true) {
      // Process securityCheck() methode of Object before response
      providers.push({
        provide: APP_INTERCEPTOR,
        useClass: CheckSecurityInterceptor,
      });
    }

    if (config.security?.mapAndValidatePipe ?? true) {
      // [Global] Map plain objects to meta-type and validate
      providers.push({
        provide: APP_PIPE,
        useClass: MapAndValidatePipe,
      });
    }

    if (config.mongoose?.modelDocumentation) {
      providers.push(ModelDocService);
    }

    // Set strict query to false by default
    // See: https://github.com/Automattic/mongoose/issues/10763
    // and: https://mongoosejs.com/docs/guide.html#strictQuery
    mongoose.set('strictQuery', config.mongoose.strictQuery || false);

    const imports: any[] = [
      MongooseModule.forRoot(config.mongoose.uri, config.mongoose.options),
      GraphQLModule.forRootAsync<ApolloDriverConfig>(
        Object.assign({ driver: ApolloDriver }, config.graphQl.driver, config.graphQl.options),
      ),
    ];
    if (config.healthCheck) {
      imports.push(CoreHealthCheckModule);
    }

    // Add BetterAuthModule based on mode
    // IAM-only mode: Always register BetterAuthModule (required for subscription auth)
    // Legacy mode: Only register if autoRegister is explicitly true
    if (config.betterAuth?.enabled !== false) {
      if (isIamOnlyMode || config.betterAuth?.autoRegister === true) {
        imports.push(
          BetterAuthModule.forRoot({
            config: config.betterAuth || {},
            // Pass JWT secrets for backwards compatibility fallback
            fallbackSecrets: [config.jwt?.secret, config.jwt?.refresh?.secret],
          }),
        );
      }
    }

    // Set exports
    const exports: any[] = [ConfigService, EmailService, TemplateService, MailjetService];
    if (!process.env.VITEST) {
      exports.push(ComplexityPlugin);
    }

    // Return dynamic module
    return {
      exports,
      imports,
      module: CoreModule,
      providers,
    };
  }

  // =============================================================================
  // GraphQL Driver Configuration Helpers
  // =============================================================================

  /**
   * Build GraphQL driver configuration for IAM-only mode
   *
   * Uses BetterAuthService for subscription authentication via JWT tokens.
   * This is the recommended mode for new projects.
   */
  private static buildIamOnlyGraphQlDriver(cors: object, options: Partial<IServerOptions>) {
    return {
      imports: [BetterAuthModule],
      inject: [BetterAuthService, BetterAuthUserMapper],
      useFactory: async (betterAuthService: BetterAuthService, userMapper: BetterAuthUserMapper) =>
        Object.assign(
          {
            autoSchemaFile: 'schema.gql',
            context: ({ req, res }) => ({ req, res }),
            cors,
            installSubscriptionHandlers: true,
            subscriptions: {
              'graphql-ws': {
                context: ({ extra }) => extra,
                onConnect: async (context: Context<any>) => {
                  const { connectionParams, extra } = context;
                  const enableAuth = options?.graphQl?.enableSubscriptionAuth ?? true;

                  if (enableAuth) {
                    // Get headers from raw headers or connection params
                    const headers = CoreModule.getHeaderFromArray(extra.request?.rawHeaders);
                    const authToken: string =
                      connectionParams?.Authorization?.split(' ')[1] ?? headers.Authorization?.split(' ')[1];

                    if (authToken) {
                      // Validate via BetterAuth session
                      const { session, user: sessionUser } = await betterAuthService.getSession({
                        headers: { authorization: `Bearer ${authToken}` },
                      });

                      if (!session || !sessionUser) {
                        throw new UnauthorizedException('Invalid or expired session');
                      }

                      // Map to full user with roles
                      const user = await userMapper.mapSessionUser(sessionUser);
                      if (!user) {
                        throw new UnauthorizedException('User not found');
                      }

                      extra.user = user;
                      extra.headers = connectionParams ?? headers;
                      return extra;
                    }

                    throw new UnauthorizedException('Missing authentication token');
                  }
                },
              },
              'subscriptions-transport-ws': {
                onConnect: async (connectionParams) => {
                  const enableAuth = options?.graphQl?.enableSubscriptionAuth ?? true;

                  if (enableAuth) {
                    const authToken: string = connectionParams?.Authorization?.split(' ')[1];

                    if (authToken) {
                      // Validate via BetterAuth session
                      const { session, user: sessionUser } = await betterAuthService.getSession({
                        headers: { authorization: `Bearer ${authToken}` },
                      });

                      if (!session || !sessionUser) {
                        throw new UnauthorizedException('Invalid or expired session');
                      }

                      // Map to full user with roles
                      const user = await userMapper.mapSessionUser(sessionUser);
                      if (!user) {
                        throw new UnauthorizedException('User not found');
                      }

                      return { headers: connectionParams, user };
                    }

                    throw new UnauthorizedException('Missing authentication token');
                  }
                },
              },
            },
          },
          options?.graphQl?.driver,
        ),
    };
  }

  /**
   * Build GraphQL driver configuration for Legacy Auth mode
   *
   * Uses the provided AuthService for subscription authentication via JWT tokens.
   * This is for existing projects that need backwards compatibility.
   *
   * @deprecated Use IAM-only mode (single-parameter forRoot) for new projects
   */
  private static buildLegacyGraphQlDriver(
    AuthService: any,
    AuthModule: any,
    cors: object,
    options: Partial<IServerOptions>,
  ) {
    // Store config reference for use in callbacks
    const enableSubscriptionAuth = options?.graphQl?.enableSubscriptionAuth ?? true;

    return {
      imports: [AuthModule],
      inject: [AuthService],
      useFactory: async (authService: any) =>
        Object.assign(
          {
            autoSchemaFile: 'schema.gql',
            context: ({ req, res }) => ({ req, res }),
            cors,
            installSubscriptionHandlers: true,
            subscriptions: {
              'graphql-ws': {
                context: ({ extra }) => extra,
                onConnect: async (context: Context<any>) => {
                  const { connectionParams, extra } = context;
                  if (enableSubscriptionAuth) {
                    // get authToken from authorization header
                    const headers = CoreModule.getHeaderFromArray(extra.request?.rawHeaders);
                    const authToken: string =
                      connectionParams?.Authorization?.split(' ')[1] ?? headers.Authorization?.split(' ')[1];
                    if (authToken) {
                      // verify authToken/getJwtPayLoad
                      const payload = authService.decodeJwt(authToken);
                      const user = await authService.validateUser(payload);
                      if (!user) {
                        throw new UnauthorizedException('No user found for token');
                      }
                      // the user/jwtPayload object found will be available as context.currentUser/jwtPayload in your GraphQL resolvers
                      extra.user = user;
                      extra.headers = connectionParams ?? headers;
                      return extra;
                    }

                    throw new UnauthorizedException('Missing authentication token');
                  }
                },
              },
              'subscriptions-transport-ws': {
                onConnect: async (connectionParams) => {
                  if (enableSubscriptionAuth) {
                    // get authToken from authorization header
                    const authToken: string = connectionParams?.Authorization?.split(' ')[1];

                    if (authToken) {
                      // verify authToken/getJwtPayLoad
                      const payload = authService.decodeJwt(authToken);
                      const user = await authService.validateUser(payload);
                      if (!user) {
                        throw new UnauthorizedException('No user found for token');
                      }
                      // the user/jwtPayload object found will be available as context.currentUser/jwtPayload in your GraphQL resolvers
                      return { headers: connectionParams, user };
                    }

                    throw new UnauthorizedException('Missing authentication token');
                  }
                },
              },
            },
          },
          options?.graphQl?.driver,
        ),
    };
  }
}
