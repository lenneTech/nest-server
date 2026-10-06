import { Logger } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { resolveApiTokenConfig } from '../../modules/api-token/core-api-token.helpers';
import { API_TOKEN_SCOPES_KEY } from '../../modules/api-token/core-api-token.constants';
import { resolveBetterAuthSessionCookieName } from '../../modules/better-auth/better-auth-cookie-prefix.helper';
import { SKIP_TENANT_CHECK_KEY } from '../../modules/tenant/core-tenant.decorators';
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

const HTTP_METHODS = ['delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'trace'] as const;

type HttpMethod = (typeof HTTP_METHODS)[number];

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
  forEachOperation(document, (path, method, operation) => {
    const reference = resolveHandler(operation.operationId, handlers);
    if (!reference) {
      logger.warn(`No handler found for operation ${operation.operationId ?? `${method.toUpperCase()} ${path}`}`);
      return;
    }
    const access = describeAccess(reference, multiTenancy);

    if (access.isPublic) {
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

  document.tags = orderTags(document, options.tags);
  return document;
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
    const kept: PathItemObject = {};
    for (const method of HTTP_METHODS) {
      const operation = item[method] as EnrichedOperation | undefined;
      if (!operation?.[SWAGGER_API_TOKEN_SCOPES_EXTENSION]?.length) {
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
  visit: (path: string, method: HttpMethod, operation: EnrichedOperation) => void,
): void {
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (operation) {
        visit(path, method, operation);
      }
    }
  }
}

/** Fields of a path item that are not operations (summary, description, servers, shared parameters). */
function pathLevelFields(item: PathItemObject): PathItemObject {
  const fields: PathItemObject = { ...item };
  for (const method of HTTP_METHODS) {
    delete fields[method];
  }
  return fields;
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
