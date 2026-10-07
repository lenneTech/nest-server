import { Logger } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { SchedulerRegistry } from '@nestjs/schedule';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { getMountedMcpOAuth } from '../../modules/ai/helpers/ai-mcp-oauth.registry';
import { resolveApiTokenConfig } from '../../modules/api-token/core-api-token.helpers';
import { API_TOKEN_SCOPES_KEY } from '../../modules/api-token/core-api-token.constants';
import { CoreAuthController } from '../../modules/auth/core-auth.controller';
import { isLegacyEndpointEnabled } from '../../modules/auth/helpers/legacy-endpoints.helper';
import { resolveBetterAuthSessionCookieName } from '../../modules/better-auth/better-auth-cookie-prefix.helper';
import {
  isBetterAuthOpenApiPath,
  isControllerHandledPath,
  isUnavailableOperation,
  switchedOffBetterAuthPaths,
} from '../../modules/better-auth/core-better-auth-openapi.helper';
import { CoreBetterAuthUserMapper } from '../../modules/better-auth/core-better-auth-user.mapper';
import { CoreBetterAuthController } from '../../modules/better-auth/core-better-auth.controller';
import { CoreBetterAuthService } from '../../modules/better-auth/core-better-auth.service';
import { CoreHubActionsController } from '../../modules/hub/core-hub-actions.controller';
import { CoreHubController } from '../../modules/hub/core-hub.controller';
import { isHubEnabled, normalizeHubConfig } from '../../modules/hub/hub-config.helper';
import { SKIP_TENANT_CHECK_KEY } from '../../modules/tenant/core-tenant.decorators';
import { API_METHODS_KEY } from '../decorators/api-methods.decorator';
import { mergeRolesMetadata } from '../../modules/tenant/core-tenant.helpers';
import { RoleEnum } from '../enums/role.enum';
import { ConfigService } from '../services/config.service';
import { isCookiesEnabled } from './cookies.helper';

import type { INestApplication, Type } from '@nestjs/common';
import type {
  OpenAPIObject,
  OperationObject,
  ParameterObject,
  PathItemObject,
  ReferenceObject,
  TagObject,
} from '@nestjs/swagger';
import type { IMountedMcpOAuth } from '../../modules/ai/helpers/ai-mcp-oauth.registry';
import type { IBetterAuthOpenApiDocument } from '../../modules/better-auth/core-better-auth-openapi.helper';
import type { ResolvedHubConfig } from '../../modules/hub/interfaces/hub-config.interface';
import type { IServerOptions } from '../interfaces/server-options.interface';
import type { ISwaggerApiTokenViewOptions, ISwaggerSetupOptions } from '../interfaces/swagger-setup-options.interface';

/**
 * Swagger setup that describes how a route is actually reached (since 11.42.7).
 *
 * The plain `DocumentBuilder().addBearerAuth()` of the starters registers a scheme but attaches it to no
 * route, so a token entered under "Authorize" is sent with almost none. And the facts a caller needs —
 * which routes are public, which API-token scope a route releases, which routes read the tenant header —
 * live only in decorators. This helper reads them from the same metadata the guards read, so the
 * document cannot drift from what the server enforces:
 *
 * - `bearer` and the session cookie are global security requirements; public routes carry `security: []`.
 * - With API tokens on, every operation states whether a token may call it, and with which scope
 *   (`x-api-token-scopes` plus a line in the description). `@ApiTokenScopes()` on the method replaces
 *   the class-level declaration, exactly as in `assertApiTokenScopes()`.
 * - With multi-tenancy on, every operation that reads the tenant header documents it as a parameter.
 * - The routes Better-Auth serves itself (two-factor, passkey, sessions, password change, … — whatever the
 *   configured plugins add) are documented from Better-Auth's own OpenAPI generator, under the project's
 *   Better-Auth controller (since 11.42.9); so are `/ai/mcp` and the MCP OAuth endpoints
 *   `mountAiMcpOAuth()` mounted.
 * - Only what can succeed under the running configuration is documented (since 11.42.9): an `@All()`
 *   handler keeps the methods `@ApiMethods()` names; legacy `/auth/*` disappears while
 *   `auth.legacyEndpoints` keeps REST closed; Better-Auth routes disappear when the configuration or the
 *   live instance refuses them; Hub endpoints disappear with their switched-off panel. Every rule reads
 *   the switch the handler itself reads — project modules are documented by the same scan, automatically.
 * - Optionally, a second document lists only the routes an API token may call.
 *
 * Each operation is mapped to its handler through the default operation id (`<Controller>_<method>`),
 * which is why an own `operationIdFactory` is not accepted.
 */

/** Name of the bearer scheme. `@ApiBearerAuth()` without arguments refers to the same name. */
export const SWAGGER_BEARER_SCHEME = 'bearer';

/** Name of the session-cookie scheme */
export const SWAGGER_COOKIE_SCHEME = 'cookie';

/** Key of the reusable tenant-header parameter in `components.parameters` */
export const SWAGGER_TENANT_HEADER_PARAMETER = 'TenantHeader';

/** Vendor extension listing the scopes an API token needs for an operation */
export const SWAGGER_API_TOKEN_SCOPES_EXTENSION = 'x-api-token-scopes';

/**
 * Fields of an OpenAPI path item that are not operations. Every other key is an operation: they are read
 * from the path item rather than from a list of HTTP methods, because `@All()` makes @nestjs/swagger emit
 * a `search` operation too, which no OpenAPI version lists — a fixed list left it unenriched.
 */
const PATH_ITEM_FIELDS = new Set(['$ref', 'description', 'parameters', 'servers', 'summary']);

/** An operation with the vendor extension this helper writes */
type EnrichedOperation = OperationObject & { [SWAGGER_API_TOKEN_SCOPES_EXTENSION]?: string[] };

interface IHandlerReference {
  controller: Type<unknown>;
  handler: (...args: unknown[]) => unknown;
  handlerName: string;
}

interface IOperationAccess {
  isPublic: boolean;
  scopes?: string[];
  skipsTenantHeader: boolean;
}

/** What the document needs to know about the Better-Auth routes of the application. */
interface IBetterAuthRoutes {
  /** Base path every Better-Auth route lives under (`/iam`) */
  basePath: string;
  /** The project's Better-Auth controller, under which the generated routes are documented */
  controller: Type<unknown>;
  /** The controller's routes are not where its metadata puts them (global prefix, URI versioning) */
  relocated?: boolean;
  /** Better-Auth's own description of the routes it serves itself */
  schema?: IBetterAuthOpenApiDocument;
  /**
   * Operations (relative to the base path) that answer an error for every caller: what the configuration
   * switches off plus what the live Better-Auth instance refuses (`isUnavailableOperation()` keys)
   */
  switchedOff: Set<string>;
  /** Tags of the controller's explicit routes, as Swagger built them (before `operationTags`) */
  tags?: string[];
}

interface IResolvedApiTokenView {
  description?: string;
  enabled: boolean;
  jsonDocumentUrl: string;
  path: string;
  title?: string;
}

const logger = new Logger('Swagger');

/**
 * Build the enriched document and serve it — plus the API-token view, when configured. Both documents are
 * built on the first request, when every module is initialised.
 */
export function setupSwagger(app: INestApplication, options: ISwaggerSetupOptions): void {
  let document: OpenAPIObject | undefined;
  const fullDocument = () => (document ??= buildSwaggerDocument(app, options));

  SwaggerModule.setup(options.path ?? 'swagger', app, fullDocument, {
    ...options.customOptions,
    jsonDocumentUrl: options.jsonDocumentUrl ?? '/api-docs-json',
  });

  const view = resolveApiTokenView(options.apiTokenView);
  if (!view.enabled) {
    return;
  }
  let viewDocument: OpenAPIObject | undefined;
  SwaggerModule.setup(view.path, app, () => (viewDocument ??= buildApiTokenSwaggerDocument(fullDocument(), view)), {
    ...options.customOptions,
    jsonDocumentUrl: view.jsonDocumentUrl,
  });
}

/**
 * The full document, enriched with security, API-token scopes and the tenant header.
 *
 * @param config - server configuration; the running configuration by default
 */
export function buildSwaggerDocument(
  app: INestApplication,
  options: ISwaggerSetupOptions,
  config: Partial<IServerOptions> = ConfigService.configFastButReadOnly ?? {},
): OpenAPIObject {
  if ((options.documentOptions as { operationIdFactory?: unknown } | undefined)?.operationIdFactory) {
    throw new Error(
      'setupSwagger: an own operationIdFactory is not supported — operations are mapped by their default id',
    );
  }
  const apiTokens = resolveApiTokenConfig(config);
  const multiTenancy = !!config.multiTenancy && config.multiTenancy.enabled !== false;
  const sessionCookie = resolveSessionCookieName(config);

  let builder = new DocumentBuilder()
    .setTitle(options.title)
    .setDescription(options.description ?? '')
    .setVersion(options.version ?? '1.0.0')
    .addBearerAuth(
      {
        description: apiTokens.enabled
          ? 'Session token from sign-in, or an API token / signed assertion of an API token.'
          : 'Session token from sign-in.',
        scheme: 'bearer',
        type: 'http',
      },
      SWAGGER_BEARER_SCHEME,
    )
    .addSecurityRequirements(SWAGGER_BEARER_SCHEME);
  if (sessionCookie) {
    builder = builder
      .addCookieAuth(
        sessionCookie,
        {
          description: `Session cookie set by sign-in (\`${sessionCookie}\`). The browser sends it by itself once you are signed in on this host.`,
          in: 'cookie',
          name: sessionCookie,
          type: 'apiKey',
        },
        SWAGGER_COOKIE_SCHEME,
      )
      .addSecurityRequirements(SWAGGER_COOKIE_SCHEME);
  }
  if (options.configureBuilder) {
    builder = options.configureBuilder(builder);
  }

  const document = SwaggerModule.createDocument(app, builder.build(), {
    autoTagControllers: true,
    deepScanRoutes: true,
    ...options.documentOptions,
  });

  const headerName = canonicalHeaderName(config.multiTenancy?.headerName ?? 'x-tenant-id');
  if (multiTenancy) {
    document.components = document.components ?? {};
    document.components.parameters = {
      ...document.components.parameters,
      [SWAGGER_TENANT_HEADER_PARAMETER]: tenantHeaderParameter(headerName, apiTokens),
    };
  }

  const handlers = indexHandlers(app);
  const betterAuthRoutes = resolveBetterAuthRoutes(app, handlers, config);
  const availability = resolveAvailability(app, config, betterAuthRoutes);
  const switchedOff: [string, string][] = [];
  forEachOperation(document, (path, method, operation) => {
    const reference = resolveHandler(operation.operationId, handlers);
    if (!reference) {
      logger.warn(`No handler found for operation ${operation.operationId ?? `${method.toUpperCase()} ${path}`}`);
      return;
    }
    if (betterAuthRoutes && isBetterAuthController(reference.controller)) {
      betterAuthRoutes.tags ??= [...(operation.tags ?? [])];
      // A global prefix or URI versioning puts the controller's routes below another base than its
      // metadata says — and then Better-Auth's own routes are not reachable at all (see
      // addBetterAuthRoutes). Compared by the controller's base only: a handler path is written in Nest's
      // syntax (`:id`, `*path`), the document's in OpenAPI's (`{id}`), so a full comparison would read
      // every parametrized route as relocated.
      const base = declaredControllerBase(reference.controller);
      if (base && path !== base && !path.startsWith(`${base}/`)) {
        betterAuthRoutes.relocated = true;
      }
    }
    if (isSwitchedOffOperation(reference, method, availability)) {
      switchedOff.push([path, method]);
      return;
    }
    const access = describeAccess(reference, multiTenancy);

    // An explicit @ApiBearerAuth()/@ApiSecurity() wins over "public": a route the guards admit to
    // everybody may still authenticate the caller itself (the MCP endpoint does).
    if (access.isPublic && !declaresSecurity(reference)) {
      operation.security = [];
    }
    if (apiTokens.enabled) {
      if (access.scopes?.length) {
        operation[SWAGGER_API_TOKEN_SCOPES_EXTENSION] = [...access.scopes];
      }
      operation.description = appendLine(operation.description, apiTokenLine(access.scopes));
    }
    if (multiTenancy && !access.isPublic && !access.skipsTenantHeader && !hasHeaderParameter(operation, headerName)) {
      operation.parameters = [
        ...(operation.parameters ?? []),
        { $ref: `#/components/parameters/${SWAGGER_TENANT_HEADER_PARAMETER}` },
      ];
    }
    if (options.operationTags) {
      const tags = options.operationTags({
        controller: reference.controller.name,
        handler: reference.handlerName,
        isPublic: access.isPublic,
        method,
        path,
        scopes: access.scopes,
        tags: [...(operation.tags ?? [])],
      });
      if (tags) {
        operation.tags = tags;
      }
    }
  });

  for (const [path, method] of switchedOff) {
    const item = document.paths[path] as Record<string, unknown>;
    delete item[method];
    if (!operationsOf(document.paths[path]).length) {
      delete document.paths[path];
    }
  }

  const added = { apiTokensEnabled: apiTokens.enabled, operationTags: options.operationTags };
  if (betterAuthRoutes?.schema) {
    if (betterAuthRoutes.relocated) {
      logger.warn(
        "Better-Auth's own routes are not documented: under a global prefix or URI versioning the API " +
          'middleware does not forward them, so none of them would be reachable at the documented path.',
      );
    } else {
      addBetterAuthRoutes(document, betterAuthRoutes, added);
    }
  }
  const mcpOAuth = getMountedMcpOAuth();
  if (mcpOAuth) {
    addMcpOAuthRoutes(document, mcpOAuth, added);
  }

  document.tags = orderTags(document, options.tags);
  return document;
}

/** What decides whether a registered route can succeed under the running configuration. */
interface IAvailability {
  /** AI module registered (the Hub's AI panel reads it) */
  ai: boolean;
  betterAuth?: IBetterAuthRoutes;
  /** Better-Auth's user mapper registered (the Hub's auth-migration panel reads it) */
  betterAuthMapper: boolean;
  config: Partial<IServerOptions>;
  /** The Hub's resolved configuration, when the Hub is enabled */
  hub?: ResolvedHubConfig;
  /** `ScheduleModule` registered (the Hub's cron panel and actions read it) */
  scheduler: boolean;
}

/** Legacy-auth REST handlers that answer 410 while `auth.legacyEndpoints` keeps REST closed */
const LEGACY_REST_HANDLERS = new Set(['logout', 'refreshToken', 'signIn', 'signUp']);

/**
 * Hub endpoints that answer `{ available: false }` (or refuse) unless their source is present — keyed by
 * handler name, read the way the Hub's own services decide it.
 */
const HUB_AVAILABILITY: Record<string, (availability: IAvailability, hub: ResolvedHubConfig) => boolean> = {
  aiJson: (availability) => availability.ai,
  authMigrationJson: (availability) => availability.betterAuthMapper,
  cron: (availability) => availability.scheduler,
  cronJson: (availability) => availability.scheduler,
  dbJson: (_availability, hub) => hub.db !== false,
  emailPreview: (_availability, hub) => hub.emailPreview,
  emailsJson: (_availability, hub) => hub.emailPreview,
  logsJson: (_availability, hub) => hub.collectors.logs !== false,
  mailboxHtml: (_availability, hub) => hub.mailbox !== false,
  mailboxJson: (_availability, hub) => hub.mailbox !== false,
  migrationsDown: (_availability, hub) => hub.migrations !== false,
  migrationsJson: (_availability, hub) => hub.migrations !== false,
  migrationsRun: (_availability, hub) => hub.migrations !== false,
  queriesJson: (_availability, hub) => hub.collectors.queries !== false,
  tracesJson: (_availability, hub) => hub.collectors.traces !== false,
};

function resolveAvailability(
  app: INestApplication,
  config: Partial<IServerOptions>,
  betterAuth: IBetterAuthRoutes | undefined,
): IAvailability {
  const ai = config.ai;
  return {
    ai: ai === true || (typeof ai === 'object' && ai !== null && (ai as { enabled?: boolean }).enabled !== false),
    betterAuth,
    betterAuthMapper: isProvided(app, CoreBetterAuthUserMapper),
    config,
    hub: isHubEnabled(config.hub) ? normalizeHubConfig(config.hub!, { env: config.env ?? '', version: '' }) : undefined,
    scheduler: isProvided(app, SchedulerRegistry),
  };
}

/** Whether a provider is registered anywhere in the application */
function isProvided(app: INestApplication, token: Type<unknown>): boolean {
  try {
    return !!app.get(token, { strict: false });
  } catch {
    return false;
  }
}

/**
 * Whether an operation of a registered handler answers an error for every caller under the running
 * configuration — documented, it could never succeed. Each rule reads the switch the handler itself reads.
 */
function isSwitchedOffOperation(reference: IHandlerReference, method: string, availability: IAvailability): boolean {
  const methods = Reflect.getMetadata(API_METHODS_KEY, reference.handler) as string[] | undefined;
  if (methods && !methods.includes(method)) {
    return true;
  }
  const { controller, handlerName } = reference;
  if (extendsClass(controller, CoreAuthController) && LEGACY_REST_HANDLERS.has(handlerName)) {
    return !isLegacyEndpointEnabled(availability.config.auth?.legacyEndpoints, 'rest');
  }
  if (availability.betterAuth && isBetterAuthController(controller)) {
    const relativePath = declaredHandlerPath(reference.handler);
    return (
      relativePath !== undefined && isUnavailableOperation(availability.betterAuth.switchedOff, method, relativePath)
    );
  }
  if (
    availability.hub &&
    (extendsClass(controller, CoreHubController) || extendsClass(controller, CoreHubActionsController)) &&
    HUB_AVAILABILITY[handlerName]
  ) {
    return !HUB_AVAILABILITY[handlerName](availability, availability.hub);
  }
  return false;
}

/** `base` itself or a class extending it */
function extendsClass(controller: Type<unknown>, base: Type<unknown>): boolean {
  return controller === base || controller.prototype instanceof base;
}

/** The handler's own route path (`sign-up/email` → `/sign-up/email`), or `undefined` for several paths */
function declaredHandlerPath(handler: IHandlerReference['handler']): string | undefined {
  const path = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
  return typeof path === 'string' ? `/${path.replace(/^\/+/, '')}`.replace(/\/$/, '') || '/' : undefined;
}

/** The path controller + handler metadata declare, without global prefix or version */
/** The path a controller declares (`/iam`), or `undefined` when it declares none or several. */
function declaredControllerBase(controller: IHandlerReference['controller']): string | undefined {
  const controllerPath = Reflect.getMetadata(PATH_METADATA, controller) as string | string[] | undefined;
  const trimmed = typeof controllerPath === 'string' ? controllerPath.replace(/^\/+|\/+$/g, '') : '';
  return trimmed ? `/${trimmed}` : undefined;
}

/** Whether the handler or its controller declares its security itself (`@ApiBearerAuth()`, `@ApiSecurity()`) */
function declaresSecurity(reference: IHandlerReference): boolean {
  return !!(
    Reflect.getMetadata('swagger/apiSecurity', reference.handler) ??
    Reflect.getMetadata('swagger/apiSecurity', reference.controller)
  );
}

/**
 * Documents the MCP OAuth 2.1 endpoints `mountAiMcpOAuth()` mounted on Express — the ones it mounted,
 * nothing else. They authenticate the client themselves, so they carry no security requirement.
 */
function addMcpOAuthRoutes(
  document: OpenAPIObject,
  mounted: IMountedMcpOAuth,
  context: { apiTokensEnabled: boolean; operationTags: ISwaggerSetupOptions['operationTags'] },
): void {
  const routes: [string, string, string, string][] = [
    [
      'get',
      '/.well-known/oauth-authorization-server',
      'authorizationServerMetadata',
      'OAuth 2.1 authorization server metadata (RFC 8414) for MCP clients.',
    ],
    [
      'get',
      `/.well-known/oauth-protected-resource${mounted.mcpPath}`,
      'protectedResourceMetadata',
      `Protected resource metadata (RFC 9728) of the MCP endpoint \`${mounted.mcpPath}\`.`,
    ],
    ['get', '/authorize', 'authorize', 'Authorization endpoint (authorization code with PKCE S256).'],
    ['post', '/authorize', 'authorizePost', 'Authorization endpoint, form post variant.'],
    ['post', '/token', 'token', 'Token endpoint: exchanges an authorization code or refresh token.'],
  ];
  if (mounted.registration) {
    routes.push(['post', '/register', 'register', 'Dynamic client registration (RFC 7591).']);
  }
  if (mounted.revocation) {
    routes.push(['post', '/revoke', 'revoke', 'Token revocation (RFC 7009).']);
  }
  for (const [method, path, name, description] of routes) {
    const operation: EnrichedOperation = {
      description: context.apiTokensEnabled ? appendLine(description, apiTokenLine(undefined)) : description,
      operationId: `McpOAuth_${name}`,
      responses: { default: { description: 'See the MCP authorization specification' } },
      security: [],
      summary: description.split(':')[0].replace(/\.$/, ''),
      tags: ['MCP OAuth'],
    };
    if (context.operationTags) {
      const tags = context.operationTags({
        controller: 'McpOAuth',
        handler: name,
        isPublic: true,
        method,
        path,
        scopes: undefined,
        tags: [...(operation.tags ?? [])],
      });
      if (tags) {
        operation.tags = tags;
      }
    }
    document.paths[path] = { ...document.paths[path], [method]: operation };
  }
}

/** `CoreBetterAuthController` or a project controller extending it */
function isBetterAuthController(controller: Type<unknown>): boolean {
  return controller === CoreBetterAuthController || controller.prototype instanceof CoreBetterAuthController;
}

/**
 * The Better-Auth routes of the application, or `undefined` when no Better-Auth controller is registered.
 * The base path and Better-Auth's own route description come from `CoreBetterAuthService`; what the
 * configuration switches off is read from `config`, like everything else this helper documents.
 */
function resolveBetterAuthRoutes(
  app: INestApplication,
  handlers: Map<string, Type<unknown>[]>,
  config: Partial<IServerOptions>,
): IBetterAuthRoutes | undefined {
  const controller = [...handlers.values()].flat().find(isBetterAuthController);
  if (!controller) {
    return undefined;
  }
  let service: CoreBetterAuthService | undefined;
  try {
    service = app.get(CoreBetterAuthService, { strict: false });
  } catch {
    service = undefined;
  }
  const betterAuth = typeof config.betterAuth === 'object' && config.betterAuth !== null ? config.betterAuth : {};
  return {
    basePath: service?.getBasePath?.() || betterAuth.basePath || '/iam',
    controller,
    schema: service?.getOpenApiSchema?.(),
    switchedOff: new Set([...switchedOffBetterAuthPaths(betterAuth), ...(service?.getUnavailableOperations?.() ?? [])]),
  };
}

/**
 * Adds the routes Better-Auth serves itself, documented like the routes of the project's Better-Auth
 * controller: its tags and `operationTags`, the global security requirement, the API-token line. Leaves
 * out what the controller handles (an explicit route always wins), what the configuration switches off,
 * and the `openAPI()` plugin's own routes. Their schemas are added with a `BetterAuth` prefix — `User`
 * and `Session` would otherwise collide with the project's models — and converted to OpenAPI 3.0.
 */
function addBetterAuthRoutes(
  document: OpenAPIObject,
  routes: IBetterAuthRoutes,
  context: { apiTokensEnabled: boolean; operationTags: ISwaggerSetupOptions['operationTags'] },
): void {
  const renamed = new Map<string, string>();
  const controllerTags = routes.tags ?? defaultControllerTags(routes.controller);
  for (const [relativePath, item] of Object.entries(routes.schema?.paths ?? {})) {
    if (isControllerHandledPath(relativePath) || isBetterAuthOpenApiPath(relativePath)) {
      continue;
    }
    const path = `${routes.basePath}${relativePath}`;
    for (const [method, source] of operationsOf(item as PathItemObject)) {
      const existing = document.paths[path] as Record<string, unknown> | undefined;
      if (existing?.[method] || isUnavailableOperation(routes.switchedOff, method, relativePath)) {
        continue;
      }
      const operation = toOpenApi30(renameSchemaRefs(structuredClone(source), renamed)) as EnrichedOperation;
      const betterAuthId = operation.operationId ?? `${method}${relativePath}`;
      operation.operationId = `${routes.controller.name}_betterAuth_${betterAuthId}`;
      // Better-Auth's generator marks every route bearer-only, public ones included.
      // CoreBetterAuthService.prepareOpenApiSchema() replaces that with what Better-Auth enforces:
      // `security: []` on a public route. Anything else gets the global requirement, so "Authorize"
      // sends the session along — the safe reading of a description that did not say.
      const isPublic = Array.isArray(operation.security) && operation.security.length === 0;
      if (!isPublic) {
        delete operation.security;
      }
      operation.tags = [...controllerTags];
      if (context.apiTokensEnabled) {
        // No route here releases a scope via @ApiTokenScopes(), so an API token is refused on all of them.
        operation.description = appendLine(operation.description, apiTokenLine(undefined));
      }
      if (context.operationTags) {
        const tags = context.operationTags({
          controller: routes.controller.name,
          handler: betterAuthId,
          isPublic,
          method,
          path,
          scopes: undefined,
          tags: [...operation.tags],
        });
        if (tags) {
          operation.tags = tags;
        }
      }
      document.paths[path] = { ...document.paths[path], [method]: operation };
    }
  }
  addRenamedSchemas(document, routes.schema?.components?.schemas ?? {}, renamed);
}

/** Tags `@ApiTags()` gives a controller, or the one `autoTagControllers` derives from its name */
function defaultControllerTags(controller: Type<unknown>): string[] {
  const tags = Reflect.getMetadata('swagger/apiUseTags', controller) as string[] | undefined;
  return tags?.length ? [...tags] : [controller.name.replace(/Controller$/, '')];
}

/** Rewrites `#/components/schemas/<Name>` to `BetterAuth<Name>`, recording each rename. */
function renameSchemaRefs<T>(value: T, renamed: Map<string, string>): T {
  const prefix = '#/components/schemas/';
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (typeof node === 'object' && node !== null) {
      const record = node as Record<string, unknown>;
      for (const [key, child] of Object.entries(record)) {
        if (key === '$ref' && typeof child === 'string' && child.startsWith(prefix)) {
          const name = child.slice(prefix.length);
          const target = renamed.get(name) ?? `BetterAuth${name}`;
          renamed.set(name, target);
          record.$ref = `${prefix}${target}`;
        } else {
          visit(child);
        }
      }
    }
  };
  visit(value);
  return value;
}

/** Copies every renamed schema — and the schemas those refer to — into the document. */
function addRenamedSchemas(
  document: OpenAPIObject,
  schemas: Record<string, unknown>,
  renamed: Map<string, string>,
): void {
  const added = new Set<string>();
  let pending = [...renamed.keys()];
  while (pending.length) {
    for (const name of pending) {
      added.add(name);
      if (!schemas[name]) {
        continue;
      }
      document.components = document.components ?? {};
      document.components.schemas = document.components.schemas ?? {};
      document.components.schemas[renamed.get(name)!] ??= toOpenApi30(
        renameSchemaRefs(structuredClone(schemas[name]), renamed),
      ) as Record<string, unknown>;
    }
    pending = [...renamed.keys()].filter((name) => !added.has(name));
  }
}

/**
 * OpenAPI 3.1 → 3.0 for what Better-Auth's generator emits: a `type` array (`['string', 'null']`) becomes
 * `type` plus `nullable`, or `anyOf` for several non-null types. The document itself is OpenAPI 3.0.
 */
function toOpenApi30<T>(value: T): T {
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (typeof node === 'object' && node !== null) {
      const record = node as Record<string, unknown>;
      if (Array.isArray(record.type)) {
        const types = record.type as string[];
        const nonNull = types.filter((type) => type !== 'null');
        if (nonNull.length > 1) {
          record.anyOf = nonNull.map((type) => ({ type }));
          delete record.type;
        } else if (nonNull.length === 1) {
          record.type = nonNull[0];
        } else {
          delete record.type;
        }
        if (types.includes('null')) {
          record.nullable = true;
        }
      }
      Object.values(record).forEach(visit);
    }
  };
  visit(value);
  return value;
}

/**
 * The document an API-token caller needs: only the operations that release a scope, authenticated with
 * the bearer scheme only, without the tenant header (a tenant token carries its tenant), and without the
 * schemas no remaining operation refers to.
 */
export function buildApiTokenSwaggerDocument(
  document: OpenAPIObject,
  options: ISwaggerApiTokenViewOptions = {},
  config: Partial<IServerOptions> = ConfigService.configFastButReadOnly ?? {},
): OpenAPIObject {
  // A company token carries its company, so the header is noise for it. A personal (user) token
  // without a company restriction chooses the company like a session does — without the header it is
  // checked against its global roles and refused on company routes. Keep it while those tokens exist.
  const keepsTenantHeader = resolveApiTokenConfig(config).userTokens;
  const view: OpenAPIObject = structuredClone(document);
  view.info = {
    ...view.info,
    description: options.description ?? view.info.description,
    title: options.title ?? `${view.info.title} — API tokens`,
  };
  view.security = [{ [SWAGGER_BEARER_SCHEME]: [] }];

  const paths: OpenAPIObject['paths'] = {};
  for (const [path, item] of Object.entries(view.paths)) {
    const kept: Record<string, EnrichedOperation> = {};
    for (const [method, operation] of operationsOf(item)) {
      if (!operation[SWAGGER_API_TOKEN_SCOPES_EXTENSION]?.length) {
        continue;
      }
      operation.security = [{ [SWAGGER_BEARER_SCHEME]: [] }];
      if (!keepsTenantHeader) {
        operation.parameters = operation.parameters?.filter(
          (parameter) =>
            !isRef(parameter) || parameter.$ref !== `#/components/parameters/${SWAGGER_TENANT_HEADER_PARAMETER}`,
        );
      }
      kept[method] = operation;
    }
    if (Object.keys(kept).length) {
      paths[path] = { ...pathLevelFields(item), ...kept };
    }
  }
  view.paths = paths;

  if (view.components) {
    const { parameters, securitySchemes } = view.components;
    if (parameters && !keepsTenantHeader) {
      delete parameters[SWAGGER_TENANT_HEADER_PARAMETER];
    }
    if (securitySchemes) {
      view.components.securitySchemes = { [SWAGGER_BEARER_SCHEME]: securitySchemes[SWAGGER_BEARER_SCHEME] };
    }
    pruneUnusedSchemas(view);
  }

  const used = new Set<string>();
  forEachOperation(view, (_path, _method, operation) => operation.tags?.forEach((tag) => used.add(tag)));
  view.tags = view.tags?.filter((tag) => used.has(tag.name));
  return view;
}

/**
 * Which roles, scopes and tenant handling apply to a handler — read the way the guards read them.
 */
function describeAccess(reference: IHandlerReference, multiTenancy: boolean): IOperationAccess {
  const handlerRoles = Reflect.getMetadata('roles', reference.handler) as string[] | undefined;
  const classRoles = Reflect.getMetadata('roles', reference.controller) as string[] | undefined;
  const roles = mergeRolesMetadata([handlerRoles, classRoles]);
  // The tenant guard lets method-level system roles override class-level ones (a class @Roles(S_EVERYONE)
  // must not make a method @Roles(S_USER) public); the role guard merges both. Public is what passes both.
  const systemRoles = handlerRoles?.length ? handlerRoles : roles;
  const isPublic =
    !roles.some(Boolean) ||
    (roles.includes(RoleEnum.S_EVERYONE) && (!multiTenancy || systemRoles.includes(RoleEnum.S_EVERYONE)));

  // Same lookup as assertApiTokenScopes(): the method declaration replaces the class declaration.
  const scopes =
    (Reflect.getMetadata(API_TOKEN_SCOPES_KEY, reference.handler) as string[] | undefined) ??
    (Reflect.getMetadata(API_TOKEN_SCOPES_KEY, reference.controller) as string[] | undefined);

  const skipsTenantHeader = !!(
    Reflect.getMetadata(SKIP_TENANT_CHECK_KEY, reference.handler) ??
    Reflect.getMetadata(SKIP_TENANT_CHECK_KEY, reference.controller)
  );

  return { isPublic, scopes: scopes?.length ? scopes : undefined, skipsTenantHeader };
}

/** Every controller class of the application, by name — the first half of a default operation id. */
function indexHandlers(app: INestApplication): Map<string, Type<unknown>[]> {
  const index = new Map<string, Type<unknown>[]>();
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as Type<unknown> | undefined;
      if (!controller?.name) {
        continue;
      }
      const known = index.get(controller.name) ?? [];
      if (!known.includes(controller)) {
        index.set(controller.name, [...known, controller]);
      }
    }
  }
  return index;
}

/**
 * Map `<Controller>_<method>` (or `<Controller>_<method>_<version>`) back to the handler. Two different
 * controller classes with the same name cannot be told apart by their operation ids; such operations are
 * left as Swagger built them.
 */
function resolveHandler(
  operationId: string | undefined,
  index: Map<string, Type<unknown>[]>,
): IHandlerReference | undefined {
  if (!operationId) {
    return undefined;
  }
  for (let separator = operationId.indexOf('_'); separator > 0; separator = operationId.indexOf('_', separator + 1)) {
    const controllers = index.get(operationId.slice(0, separator));
    if (!controllers) {
      continue;
    }
    if (controllers.length > 1) {
      logger.warn(
        `Controller name ${controllers[0].name} is used by ${controllers.length} classes; ${operationId} is not enriched`,
      );
      return undefined;
    }
    const controller = controllers[0];
    // A handler serving several paths (`@Get(['a', 'b'])`) gets `<method>[<index>]` per path.
    const rest = operationId.slice(separator + 1).replace(/\[\d+\]/g, '');
    for (const handlerName of [rest, rest.replace(/_[^_]+$/, '')]) {
      const handler = (controller.prototype as Record<string, unknown>)[handlerName];
      if (typeof handler === 'function') {
        return { controller, handler: handler as IHandlerReference['handler'], handlerName };
      }
    }
  }
  return undefined;
}

function resolveApiTokenView(option: ISwaggerSetupOptions['apiTokenView']): IResolvedApiTokenView {
  const options: ISwaggerApiTokenViewOptions = typeof option === 'object' && option !== null ? option : {};
  return {
    description: options.description,
    enabled: option === true || (typeof option === 'object' && option !== null && option.enabled !== false),
    jsonDocumentUrl: options.jsonDocumentUrl ?? '/api-docs-api-tokens-json',
    path: options.path ?? 'swagger-api-tokens',
    title: options.title,
  };
}

/** Name of the Better-Auth session cookie, or `undefined` when no session cookie is set. */
function resolveSessionCookieName(config: Partial<IServerOptions>): string | undefined {
  const betterAuth = config.betterAuth;
  if (betterAuth === false || (typeof betterAuth === 'object' && betterAuth?.enabled === false)) {
    return undefined;
  }
  if (!isCookiesEnabled(config.cookies)) {
    return undefined;
  }
  return resolveBetterAuthSessionCookieName(typeof betterAuth === 'object' ? (betterAuth.basePath ?? '/iam') : '/iam');
}

function tenantHeaderParameter(
  name: string,
  apiTokens: { tenantTokens: boolean; userTokens: boolean },
): ParameterObject {
  return {
    description: [
      'Company (tenant) the request acts in.',
      'Session callers: required on company routes; on routes open to every signed-in user it is optional and validated when sent.',
      apiTokens.tenantTokens
        ? 'API tokens of a company carry their company and may omit it; when sent, it must name that company.'
        : '',
      apiTokens.userTokens
        ? 'A personal API token chooses the company like a session; one restricted to a company may omit it.'
        : '',
    ]
      .filter(Boolean)
      .join(' '),
    in: 'header',
    name,
    required: false,
    schema: { type: 'string' },
  };
}

function apiTokenLine(scopes: string[] | undefined): string {
  return scopes?.length
    ? `**API tokens:** allowed with scope ${scopes.map((scope) => `\`${scope}\``).join(' or ')}.`
    : '**API tokens:** not allowed on this route.';
}

function appendLine(description: string | undefined, line: string): string {
  return description ? `${description}\n\n${line}` : line;
}

/** `x-tenant-id` → `X-Tenant-Id`; header names are case-insensitive, the canonical form reads better. */
function canonicalHeaderName(name: string): string {
  return name
    .split('-')
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1).toLowerCase() : part))
    .join('-');
}

function hasHeaderParameter(operation: OperationObject, name: string): boolean {
  return !!operation.parameters?.some(
    (parameter) =>
      !isRef(parameter) && parameter.in === 'header' && parameter.name.toLowerCase() === name.toLowerCase(),
  );
}

function isRef(value: unknown): value is ReferenceObject {
  return typeof value === 'object' && value !== null && '$ref' in value;
}

function forEachOperation(
  document: OpenAPIObject,
  visit: (path: string, method: string, operation: EnrichedOperation) => void,
): void {
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of operationsOf(item)) {
      visit(path, method, operation);
    }
  }
}

/** A path-item key that is not an operation: a field OpenAPI defines there, or a vendor extension. */
function isPathItemField(key: string): boolean {
  return PATH_ITEM_FIELDS.has(key) || key.startsWith('x-');
}

/** The operations of a path item, keyed by their lower-case HTTP method (`get`, ..., `search`). */
function operationsOf(item: PathItemObject): [string, EnrichedOperation][] {
  return Object.entries(item).filter(
    ([key, value]) => !isPathItemField(key) && typeof value === 'object' && value !== null && !Array.isArray(value),
  ) as [string, EnrichedOperation][];
}

/** Fields of a path item that are not operations (summary, description, servers, shared parameters). */
function pathLevelFields(item: PathItemObject): PathItemObject {
  return Object.fromEntries(Object.entries(item).filter(([key]) => isPathItemField(key))) as PathItemObject;
}

/**
 * Tags in the configured order first, then every other tag in order of first use — each with its
 * description, when one is configured.
 */
function orderTags(document: OpenAPIObject, configured: ISwaggerSetupOptions['tags']): TagObject[] {
  const used: string[] = [];
  forEachOperation(document, (_path, _method, operation) => {
    for (const tag of operation.tags ?? []) {
      if (!used.includes(tag)) {
        used.push(tag);
      }
    }
  });
  const existing = new Map((document.tags ?? []).map((tag) => [tag.name, tag]));
  const ordered: TagObject[] = [];
  for (const tag of configured ?? []) {
    if (used.includes(tag.name)) {
      ordered.push({ ...existing.get(tag.name), ...tag });
    }
  }
  for (const name of used) {
    if (!ordered.some((tag) => tag.name === name)) {
      ordered.push(existing.get(name) ?? { name });
    }
  }
  return ordered;
}

/** Drop component schemas that no operation reaches, directly or through other schemas. */
function pruneUnusedSchemas(document: OpenAPIObject): void {
  const schemas = document.components?.schemas;
  if (!schemas) {
    return;
  }
  const prefix = '#/components/schemas/';
  const reached = new Set<string>();
  const pending: unknown[] = [
    document.paths,
    document.components?.parameters,
    document.components?.requestBodies,
    document.components?.responses,
  ];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        if (key === '$ref' && typeof child === 'string' && child.startsWith(prefix)) {
          const name = child.slice(prefix.length);
          if (!reached.has(name)) {
            reached.add(name);
            pending.push(schemas[name]);
          }
        } else {
          pending.push(child);
        }
      }
    }
  }
  for (const name of Object.keys(schemas)) {
    if (!reached.has(name)) {
      delete schemas[name];
    }
  }
}
