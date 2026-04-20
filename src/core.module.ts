import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { DynamicModule, Global, MiddlewareConsumer, Module, NestModule, UnauthorizedException } from '@nestjs/common';
import { APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { MongooseModule } from '@nestjs/mongoose';
import type { Context } from 'graphql-ws';
import graphqlUploadExpress = require('graphql-upload/graphqlUploadExpress.js');
import mongoose from 'mongoose';

import { merge } from './core/common/helpers/config.helper';
import { CheckResponseInterceptor } from './core/common/interceptors/check-response.interceptor';
import { CheckSecurityInterceptor } from './core/common/interceptors/check-security.interceptor';
import { ResponseModelInterceptor } from './core/common/interceptors/response-model.interceptor';
import { TranslateResponseInterceptor } from './core/common/interceptors/translate-response.interceptor';
import {
  assertCookiesProductionSafe,
  buildCorsConfig,
  isCookiesEnabled,
  isCorsDisabled,
  isExposeTokenInBodyEnabled,
} from './core/common/helpers/cookies.helper';
import {
  ICookiesConfig,
  ICoreModuleOverrides,
  IServerOptions,
} from './core/common/interfaces/server-options.interface';
import { RequestContextMiddleware } from './core/common/middleware/request-context.middleware';
import { MapAndValidatePipe } from './core/common/pipes/map-and-validate.pipe';
import { ComplexityPlugin } from './core/common/plugins/complexity.plugin';
import { mongooseIdPlugin } from './core/common/plugins/mongoose-id.plugin';
import { mongooseAuditFieldsPlugin } from './core/common/plugins/mongoose-audit-fields.plugin';
import { mongoosePasswordPlugin } from './core/common/plugins/mongoose-password.plugin';
import { mongooseRoleGuardPlugin } from './core/common/plugins/mongoose-role-guard.plugin';
import { mongooseTenantPlugin } from './core/common/plugins/mongoose-tenant.plugin';
import { ConfigService } from './core/common/services/config.service';
import { EmailService } from './core/common/services/email.service';
import { MailjetService } from './core/common/services/mailjet.service';
import { ModelDocService } from './core/common/services/model-doc.service';
import { TemplateService } from './core/common/services/template.service';
import { CoreBetterAuthUserMapper } from './core/modules/better-auth/core-better-auth-user.mapper';
import { CoreBetterAuthModule } from './core/modules/better-auth/core-better-auth.module';
import { CoreBetterAuthService } from './core/modules/better-auth/core-better-auth.service';
import { ErrorCodeModule } from './core/modules/error-code/error-code.module';
import { CoreHealthCheckModule } from './core/modules/health-check/core-health-check.module';
import { CorePermissionsModule } from './core/modules/permissions/core-permissions.module';
import { CoreSystemSetupModule } from './core/modules/system-setup/core-system-setup.module';
import { CoreTenantModule } from './core/modules/tenant/core-tenant.module';

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
  private static graphQlEnabled = true;

  /**
   * Integrate middleware, e.g. GraphQL upload handing for express
   */
  configure(consumer: MiddlewareConsumer) {
    // RequestContext middleware must run for all routes to provide AsyncLocalStorage context
    consumer.apply(RequestContextMiddleware).forRoutes('*');
    if (CoreModule.graphQlEnabled) {
      consumer.apply(graphqlUploadExpress()).forRoutes('graphql');
    }
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
   *
   * // With module overrides (custom controllers/resolvers/services)
   * CoreModule.forRoot(envConfig, {
   *   errorCode: { controller: ErrorCodeController, service: ErrorCodeService },
   *   betterAuth: { resolver: BetterAuthResolver },
   * })
   * ```
   *
   * Use this for new projects that only use BetterAuth (IAM) for authentication.
   * GraphQL Subscription authentication uses BetterAuth JWT tokens.
   *
   * **Requirements:**
   * - Configure `betterAuth` in your config (enabled by default)
   * - Create CoreBetterAuthModule, Resolver, and Controller in your project
   * - Inject CoreBetterAuthUserMapper in UserService
   *
   * ### Legacy + IAM Signature (For existing projects)
   *
   * ```typescript
   * CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(envConfig.jwt), envConfig)
   *
   * // With module overrides
   * CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(envConfig.jwt), envConfig, {
   *   errorCode: { controller: ErrorCodeController, service: ErrorCodeService },
   * })
   * ```
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
  static forRoot(options: Partial<IServerOptions>, overrides?: ICoreModuleOverrides): DynamicModule;
  /**
   * @deprecated Use the single-parameter signature `CoreModule.forRoot(envConfig)` for new projects.
   * This 3-parameter signature is for existing projects during migration to IAM.
   */
  static forRoot(
    AuthService: any,
    AuthModule: any,
    options: Partial<IServerOptions>,
    overrides?: ICoreModuleOverrides,
  ): DynamicModule;
  static forRoot(
    authServiceOrOptions: any,
    authModuleOrUndefined?: any,
    optionsOrUndefined?: Partial<IServerOptions>,
    overridesOrUndefined?: ICoreModuleOverrides,
  ): DynamicModule {
    // Detect which signature was used:
    // IAM-only: forRoot(config, overrides?) — first arg is a plain object (config)
    // Legacy:   forRoot(AuthService, AuthModule, config, overrides?) — first arg is a class (function)
    const isIamOnlyMode = typeof authServiceOrOptions !== 'function';
    const AuthService = isIamOnlyMode ? null : authServiceOrOptions;
    const AuthModule = isIamOnlyMode ? null : authModuleOrUndefined;
    const options: Partial<IServerOptions> = isIamOnlyMode ? authServiceOrOptions : optionsOrUndefined;
    // For IAM-only mode: overrides is the 2nd param; for legacy mode: it's the 4th param.
    // The cast is safe: the public overloads guarantee the 2nd arg is ICoreModuleOverrides | undefined
    // in IAM-only mode (typeof first arg !== 'function'), never a DynamicModule (AuthModule).
    const overrides: ICoreModuleOverrides | undefined = isIamOnlyMode
      ? (authModuleOrUndefined as ICoreModuleOverrides | undefined)
      : overridesOrUndefined;

    // Guard against unsafe cookie configuration in production/staging.
    // Throws if `cookies.exposeTokenInBody: true` is set in a production-like environment.
    assertCookiesProductionSafe(options?.cookies, options?.env);

    // Process CORS config (unified across GraphQL, REST, and BetterAuth).
    // When CORS is explicitly disabled, pass `false` to Apollo — not `{}`.
    // Apollo treats `cors: {}` as "open CORS with no credentials" (via Express cors() defaults),
    // so we must distinguish the "disabled" case from the "no origins configured" case.
    const cors: false | object = isCorsDisabled(options?.cors) ? false : buildCorsConfig(options);

    // Determine if GraphQL is enabled (false means explicitly disabled)
    const isGraphQlEnabled = options.graphQl !== false;
    CoreModule.graphQlEnabled = isGraphQlEnabled;

    // Check if autoRegister: false for IAM-only mode (project imports its own BetterAuth module)
    const rawBetterAuth = options?.betterAuth;
    const isAutoRegisterDisabledEarly = typeof rawBetterAuth === 'object' && rawBetterAuth?.autoRegister === false;

    // Build GraphQL driver configuration based on auth mode (only if GraphQL is enabled)
    let graphQlDriverConfig = {};
    if (isGraphQlEnabled) {
      graphQlDriverConfig = isIamOnlyMode
        ? isAutoRegisterDisabledEarly
          ? this.buildLazyIamGraphQlDriver(cors, options)
          : this.buildIamOnlyGraphQlDriver(cors, options)
        : this.buildLegacyGraphQlDriver(AuthService, AuthModule, cors, options);
    }

    const config: IServerOptions = merge(
      {
        env: 'develop',
        ...(isGraphQlEnabled
          ? {
              graphQl: {
                driver: graphQlDriverConfig,
                enableSubscriptionAuth: true,
              },
            }
          : {}),
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

    // Wrap connectionFactory to add security plugins (password hashing, role guard)
    const originalConnectionFactory = config.mongoose?.options?.connectionFactory;
    config.mongoose.options = config.mongoose.options || {};
    config.mongoose.options.connectionFactory = (connection, name) => {
      // Run original factory first (includes mongooseIdPlugin from defaults)
      if (originalConnectionFactory) {
        connection = originalConnectionFactory(connection, name);
      }
      // Add password hashing plugin (enabled by default, opt-out via config)
      if (config.security?.mongoosePasswordPlugin !== false) {
        connection.plugin(mongoosePasswordPlugin);
      }
      // Add role guard plugin (enabled by default, opt-out via config)
      if (config.security?.mongooseRoleGuardPlugin !== false) {
        connection.plugin(mongooseRoleGuardPlugin);
      }
      // Add audit fields plugin (enabled by default, opt-out via config)
      if (config.security?.mongooseAuditFieldsPlugin !== false) {
        connection.plugin(mongooseAuditFieldsPlugin);
      }
      // Add tenant isolation plugin (opt-in via multiTenancy config)
      if (config.multiTenancy && config.multiTenancy.enabled !== false) {
        connection.plugin(mongooseTenantPlugin);
      }
      return connection;
    };

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

    // Add ComplexityPlugin only if not in Vitest (Vitest has dual GraphQL loading issue) and GraphQL is enabled
    if (!process.env.VITEST && isGraphQlEnabled) {
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

    // TranslateResponseInterceptor: Applies _translations based on Accept-Language header
    // Registered after security interceptors → runs before them on response
    // Translation happens before security checks strip restricted fields
    if (config.security?.translateResponseInterceptor !== false) {
      providers.push({
        provide: APP_INTERCEPTOR,
        useClass: TranslateResponseInterceptor,
      });
    }

    // ResponseModelInterceptor: Auto-converts plain objects to model instances
    // Registered last → runs first on response (NestJS reverse order for interceptors)
    // This ensures plain objects get securityCheck() and @Restricted metadata before other interceptors check them
    if (config.security?.responseModelInterceptor !== false) {
      providers.push({
        provide: APP_INTERCEPTOR,
        useClass: ResponseModelInterceptor,
      });
    }

    if (config.mongoose?.modelDocumentation) {
      providers.push(ModelDocService);
    }

    // Set strict query to false by default
    // See: https://github.com/Automattic/mongoose/issues/10763
    // and: https://mongoosejs.com/docs/guide.html#strictQuery
    mongoose.set('strictQuery', config.mongoose.strictQuery || false);

    const imports: any[] = [MongooseModule.forRoot(config.mongoose.uri, config.mongoose.options)];

    if (isGraphQlEnabled && config.graphQl) {
      imports.push(
        GraphQLModule.forRootAsync<ApolloDriverConfig>(
          Object.assign({ driver: ApolloDriver }, config.graphQl.driver, config.graphQl.options),
        ),
      );
    }

    // Add ErrorCodeModule based on configuration
    // autoRegister defaults to true (backward compatible)
    const errorCodeConfig = config.errorCode;
    const isErrorCodeAutoRegister = errorCodeConfig?.autoRegister !== false;

    if (!isErrorCodeAutoRegister && (overrides?.errorCode?.controller || overrides?.errorCode?.service)) {
      console.warn(
        'CoreModule: errorCode overrides are ignored because errorCode.autoRegister is false. ' +
          'Either remove autoRegister: false or pass controller/service to your own ErrorCodeModule.forRoot() call.',
      );
    }

    if (isErrorCodeAutoRegister) {
      // Always use forRoot() - it registers the controller and handles configuration
      // Overrides take precedence over config for controller/service
      imports.push(
        ErrorCodeModule.forRoot({
          additionalErrorRegistry: errorCodeConfig?.additionalErrorRegistry,
          controller: overrides?.errorCode?.controller,
          service: overrides?.errorCode?.service,
        }),
      );
    }

    if (config.healthCheck) {
      imports.push(CoreHealthCheckModule);
    }

    // Permissions report (development tool)
    const permissionsConfig = config.permissions;
    if (permissionsConfig === true || (typeof permissionsConfig === 'object' && permissionsConfig.enabled !== false)) {
      imports.push(CorePermissionsModule.forRoot(permissionsConfig));
    }

    // Add CoreBetterAuthModule based on mode
    // IAM-only mode: BetterAuth is enabled by default (it's the only auth option)
    // Legacy mode: Only register if autoRegister is explicitly true
    // betterAuth can be: boolean | IBetterAuth | undefined
    const betterAuthConfig = config.betterAuth;

    // Determine if BetterAuth is explicitly disabled
    // In IAM-only mode: enabled by default (undefined = true), only false or { enabled: false } disables
    // In Legacy mode: disabled by default (undefined = false), must be explicitly enabled
    const isExplicitlyDisabled =
      betterAuthConfig === false || (typeof betterAuthConfig === 'object' && betterAuthConfig?.enabled === false);
    const isExplicitlyEnabled =
      betterAuthConfig === true || (typeof betterAuthConfig === 'object' && betterAuthConfig?.enabled !== false);

    // IAM-only mode: enabled unless explicitly disabled
    // Legacy mode: enabled only if explicitly enabled
    const isBetterAuthEnabled = isIamOnlyMode ? !isExplicitlyDisabled : isExplicitlyEnabled;

    const isAutoRegister = typeof betterAuthConfig === 'object' && betterAuthConfig?.autoRegister === true;
    // autoRegister: false means the project imports its own BetterAuthModule separately
    const isAutoRegisterDisabled = typeof betterAuthConfig === 'object' && betterAuthConfig?.autoRegister === false;

    // Extract custom controller/resolver: overrides take precedence over config fields
    const configController = typeof betterAuthConfig === 'object' ? betterAuthConfig?.controller : undefined;
    const configResolver = typeof betterAuthConfig === 'object' ? betterAuthConfig?.resolver : undefined;

    if (isAutoRegisterDisabled && (overrides?.betterAuth?.controller || overrides?.betterAuth?.resolver)) {
      console.warn(
        'CoreModule: betterAuth overrides are ignored because betterAuth.autoRegister is false. ' +
          'Either remove autoRegister: false or pass controller/resolver to your own BetterAuthModule.forRoot() call.',
      );
    }

    if (isBetterAuthEnabled) {
      if ((isIamOnlyMode && !isAutoRegisterDisabled) || isAutoRegister) {
        imports.push(
          CoreBetterAuthModule.forRoot({
            config: betterAuthConfig === true ? {} : betterAuthConfig || {},
            // Overrides take precedence over config fields (backward compatible)
            controller: overrides?.betterAuth?.controller || configController,
            // Pass JWT secrets for backwards compatibility fallback
            fallbackSecrets: [config.jwt?.secret, config.jwt?.refresh?.secret],
            // In IAM-only mode, register RolesGuard globally to enforce @Roles() decorators
            // In Legacy mode (autoRegister), RolesGuard is already registered via CoreAuthModule
            registerRolesGuardGlobally: isIamOnlyMode,
            // Overrides take precedence over config fields (backward compatible)
            resolver: overrides?.betterAuth?.resolver || configResolver,
            // Pass server-level URLs for Passkey auto-detection
            // When env: 'local', defaults are: baseUrl=localhost:3000, appUrl=localhost:3001
            serverAppUrl: config.appUrl,
            serverBaseUrl: config.baseUrl,
            // Pass server-level CORS config so BetterAuth trustedOrigins aligns
            serverCorsConfig: config.cors,
            serverEnv: config.env,
          }),
        );
      }
    }

    // Add CoreSystemSetupModule when BetterAuth is active
    // Enabled by default - disable explicitly via systemSetup: { enabled: false }
    if (isBetterAuthEnabled && config.systemSetup?.enabled !== false) {
      imports.push(CoreSystemSetupModule);
    }

    // Add CoreTenantModule when multiTenancy is configured (presence implies enabled)
    if (config.multiTenancy && config.multiTenancy.enabled !== false) {
      // Auto-add TenantMember to excludeSchemas (membership is tenant-spanning)
      const membershipModelName = config.multiTenancy.membershipModel ?? 'TenantMember';
      if (!config.multiTenancy.excludeSchemas) {
        config.multiTenancy.excludeSchemas = [];
      }
      if (!config.multiTenancy.excludeSchemas.includes(membershipModelName)) {
        config.multiTenancy.excludeSchemas.push(membershipModelName);
      }

      imports.push(CoreTenantModule.forRoot({ modelName: membershipModelName }));
    }

    // Set exports
    const exports: any[] = [ConfigService, EmailService, TemplateService, MailjetService];
    if (!process.env.VITEST && isGraphQlEnabled) {
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
   * Uses CoreBetterAuthService for subscription authentication via JWT tokens.
   * This is the recommended mode for new projects.
   */
  private static buildIamOnlyGraphQlDriver(cors: false | object, options: Partial<IServerOptions>) {
    // This method is only called when graphQl !== false, extract config with type narrowing
    const graphQlOpts = typeof options?.graphQl === 'object' ? options.graphQl : undefined;
    return {
      imports: [CoreBetterAuthModule],
      inject: [CoreBetterAuthService, CoreBetterAuthUserMapper],
      useFactory: async (betterAuthService: CoreBetterAuthService, userMapper: CoreBetterAuthUserMapper) =>
        Object.assign(
          {
            autoSchemaFile: 'schema.gql',
            context: ({ req, res }) => ({ req, res }),
            cors,
            installSubscriptionHandlers: true,
            subscriptions: {
              'graphql-ws': {
                context: ({ extra }) => extra,
                onConnect: async (context: Context<any, any>) => {
                  const { connectionParams, extra } = context;
                  const enableAuth = graphQlOpts?.enableSubscriptionAuth ?? true;

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
                  const enableAuth = graphQlOpts?.enableSubscriptionAuth ?? true;

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
          graphQlOpts?.driver,
        ),
    };
  }

  /**
   * Build a lazy GraphQL driver for IAM-only mode with autoRegister: false.
   *
   * When autoRegister: false, CoreBetterAuthModule is NOT imported by CoreModule,
   * so we cannot use `imports` or `inject` to get BetterAuth services.
   * Instead, we resolve them lazily via static getters on CoreBetterAuthModule.
   * This is safe because `onConnect` is only called when a WebSocket connection is made,
   * which happens after all modules are initialized.
   */
  private static buildLazyIamGraphQlDriver(cors: false | object, options: Partial<IServerOptions>) {
    // This method is only called when graphQl !== false, extract config with type narrowing
    const graphQlOpts = typeof options?.graphQl === 'object' ? options.graphQl : undefined;
    return {
      useFactory: async () =>
        Object.assign(
          {
            autoSchemaFile: 'schema.gql',
            context: ({ req, res }) => ({ req, res }),
            cors,
            installSubscriptionHandlers: true,
            subscriptions: {
              'graphql-ws': {
                context: ({ extra }) => extra,
                onConnect: async (context: Context<any, any>) => {
                  const { connectionParams, extra } = context;
                  const enableAuth = graphQlOpts?.enableSubscriptionAuth ?? true;

                  if (enableAuth) {
                    const betterAuthService = CoreBetterAuthModule.getServiceInstance();
                    const userMapper = CoreBetterAuthModule.getUserMapperInstance();

                    if (!betterAuthService || !userMapper) {
                      throw new UnauthorizedException('BetterAuth not initialized');
                    }

                    const headers = CoreModule.getHeaderFromArray(extra.request?.rawHeaders);
                    const authToken: string =
                      connectionParams?.Authorization?.split(' ')[1] ?? headers.Authorization?.split(' ')[1];

                    if (authToken) {
                      const { session, user: sessionUser } = await betterAuthService.getSession({
                        headers: { authorization: `Bearer ${authToken}` },
                      });

                      if (!session || !sessionUser) {
                        throw new UnauthorizedException('Invalid or expired session');
                      }

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
                  const enableAuth = graphQlOpts?.enableSubscriptionAuth ?? true;

                  if (enableAuth) {
                    const betterAuthService = CoreBetterAuthModule.getServiceInstance();
                    const userMapper = CoreBetterAuthModule.getUserMapperInstance();

                    if (!betterAuthService || !userMapper) {
                      throw new UnauthorizedException('BetterAuth not initialized');
                    }

                    const authToken: string = connectionParams?.Authorization?.split(' ')[1];

                    if (authToken) {
                      const { session, user: sessionUser } = await betterAuthService.getSession({
                        headers: { authorization: `Bearer ${authToken}` },
                      });

                      if (!session || !sessionUser) {
                        throw new UnauthorizedException('Invalid or expired session');
                      }

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
          graphQlOpts?.driver,
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
    cors: false | object,
    options: Partial<IServerOptions>,
  ) {
    // This method is only called when graphQl !== false, extract config with type narrowing
    const graphQlOpts = typeof options?.graphQl === 'object' ? options.graphQl : undefined;
    const enableSubscriptionAuth = graphQlOpts?.enableSubscriptionAuth ?? true;

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
                onConnect: async (context: Context<any, any>) => {
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
          graphQlOpts?.driver,
        ),
    };
  }

  /**
   * @deprecated Use `isCookiesEnabled` from `core/common/helpers/cookies.helper` instead.
   */
  static isCookiesEnabled(cookies: boolean | ICookiesConfig | undefined): boolean {
    return isCookiesEnabled(cookies);
  }

  /**
   * @deprecated Use `isExposeTokenInBodyEnabled` from `core/common/helpers/cookies.helper` instead.
   */
  static isExposeTokenInBodyEnabled(cookies: boolean | ICookiesConfig | undefined): boolean {
    return isExposeTokenInBodyEnabled(cookies);
  }
}
