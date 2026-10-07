import { All, Controller, Get, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ApiOkResponse, ApiProperty } from '@nestjs/swagger';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Roles } from '../../src/core/common/decorators/roles.decorator';
import { RoleEnum } from '../../src/core/common/enums/role.enum';
import {
  buildApiTokenSwaggerDocument,
  buildSwaggerDocument,
  setupSwagger,
  SWAGGER_API_TOKEN_SCOPES_EXTENSION,
  SWAGGER_TENANT_HEADER_PARAMETER,
} from '../../src/core/common/helpers/swagger.helper';
import { ApiTokenScopes } from '../../src/core/modules/api-token/core-api-token.decorators';
import { CoreBetterAuthController } from '../../src/core/modules/better-auth/core-better-auth.controller';
import { SkipTenantCheck } from '../../src/core/modules/tenant/core-tenant.decorators';

import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject, OperationObject } from '@nestjs/swagger';
import type { IServerOptions } from '../../src/core/common/interfaces/server-options.interface';

/**
 * The helper exists so the Swagger document cannot drift from what the guards enforce. These tests
 * therefore declare routes the way a project does — `@Roles`, `@ApiTokenScopes`, `@SkipTenantCheck` on
 * class and method — and assert the document says what the guards would decide: public or not, which
 * scope a token needs (method replacing class, as in `assertApiTokenScopes()`), and whether the tenant
 * header is read.
 */

class ItemOutput {
  @ApiProperty()
  name: string;
}

class InternalOutput {
  @ApiProperty()
  secret: string;
}

@Controller('items')
@Roles('member')
@ApiTokenScopes('read')
class ItemController {
  @Get()
  @ApiOkResponse({ type: ItemOutput })
  list(): ItemOutput[] {
    return [];
  }

  @Post()
  @ApiTokenScopes('write')
  create(): void {}

  // One handler on two paths: Swagger names its operations `history[0]` / `history[1]`.
  @Get(['archive', 'history'])
  history(): void {}
}

@Controller('internal')
@Roles(RoleEnum.ADMIN)
@SkipTenantCheck()
class InternalController {
  @Get()
  @ApiOkResponse({ type: InternalOutput })
  read(): InternalOutput {
    return { secret: '' };
  }
}

@Controller('mixed')
@Roles(RoleEnum.S_EVERYONE)
class MixedController {
  @Get('open')
  open(): void {}

  // A method-level system role overrides a class-level S_EVERYONE in the tenant guard: not public.
  @Get('signed-in')
  @Roles(RoleEnum.S_USER)
  signedIn(): void {}
}

@Module({ controllers: [ItemController, InternalController, MixedController] })
class SwaggerTestModule {}

// `@All()` is documented as one operation per HTTP method — SEARCH included, which is not one of the
// methods an OpenAPI path item defines. Kept in its own module so the exact path and tag lists asserted
// against SwaggerTestModule stay as they are.
@Controller('relay')
@Roles('member')
@ApiTokenScopes('read')
class RelayController {
  @All()
  relay(): void {}
}

@Module({ controllers: [RelayController] })
class RelayTestModule {}

const fullConfig: Partial<IServerOptions> = {
  apiTokens: { scopes: ['read', 'write'] },
  betterAuth: { basePath: '/iam' },
  cookies: true,
  multiTenancy: {},
};

/** Only company tokens: a personal token, which would need the tenant header, cannot exist. */
const companyTokensOnly: Partial<IServerOptions> = {
  ...fullConfig,
  apiTokens: { scopes: ['read', 'write'], userTokens: false },
};

const options = {
  apiTokenView: { path: 'swagger-partner', title: 'Partner API' },
  description: 'Test API',
  title: 'Test',
  version: '1.2.3',
};

function operation(
  document: OpenAPIObject,
  path: string,
  method: 'get' | 'post',
): OperationObject & Record<string, any> {
  const found = document.paths[path]?.[method];
  expect(found, `${method.toUpperCase()} ${path} is documented`).toBeDefined();
  return found as OperationObject & Record<string, any>;
}

function hasTenantHeader(op: OperationObject): boolean {
  return !!op.parameters?.some(
    (parameter) =>
      '$ref' in parameter && parameter.$ref === `#/components/parameters/${SWAGGER_TENANT_HEADER_PARAMETER}`,
  );
}

describe('Swagger helper', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SwaggerTestModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('full document', () => {
    let document: OpenAPIObject;

    beforeAll(() => {
      document = buildSwaggerDocument(app, options, fullConfig);
    });

    it('requires bearer or the session cookie globally, so "Authorize" applies to every route', () => {
      expect(document.security).toEqual([{ bearer: [] }, { cookie: [] }]);
      expect(document.components?.securitySchemes?.bearer).toMatchObject({ scheme: 'bearer', type: 'http' });
      expect(document.components?.securitySchemes?.cookie).toMatchObject({
        in: 'cookie',
        name: 'iam.session_token',
        type: 'apiKey',
      });
    });

    it('marks public routes as needing no credentials', () => {
      expect(operation(document, '/mixed/open', 'get').security).toEqual([]);
      expect(operation(document, '/items', 'get').security).toBeUndefined();
    });

    it('does not treat a method-level S_USER under a class-level S_EVERYONE as public', () => {
      expect(operation(document, '/mixed/signed-in', 'get').security).toBeUndefined();
    });

    it('states the API-token scope, inherited from the class or replaced by the method', () => {
      const list = operation(document, '/items', 'get');
      expect(list[SWAGGER_API_TOKEN_SCOPES_EXTENSION]).toEqual(['read']);
      expect(list.description).toContain('**API tokens:** allowed with scope `read`.');

      const create = operation(document, '/items', 'post');
      expect(create[SWAGGER_API_TOKEN_SCOPES_EXTENSION]).toEqual(['write']);
    });

    it('says when a route refuses API tokens', () => {
      const internal = operation(document, '/internal', 'get');
      expect(internal[SWAGGER_API_TOKEN_SCOPES_EXTENSION]).toBeUndefined();
      expect(internal.description).toContain('**API tokens:** not allowed on this route.');
    });

    it('documents the tenant header where the tenant guard reads it', () => {
      const parameter = document.components?.parameters?.[SWAGGER_TENANT_HEADER_PARAMETER];
      expect(parameter).toMatchObject({ in: 'header', name: 'X-Tenant-Id', required: false });
      expect(hasTenantHeader(operation(document, '/items', 'get'))).toBe(true);
      expect(hasTenantHeader(operation(document, '/mixed/signed-in', 'get'))).toBe(true);
      expect(hasTenantHeader(operation(document, '/mixed/open', 'get'))).toBe(false);
      expect(hasTenantHeader(operation(document, '/internal', 'get'))).toBe(false);
    });

    it('takes the configured header name', () => {
      const custom = buildSwaggerDocument(app, options, { ...fullConfig, multiTenancy: { headerName: 'x-company' } });
      expect(custom.components?.parameters?.[SWAGGER_TENANT_HEADER_PARAMETER]).toMatchObject({ name: 'X-Company' });
    });

    it('adds nothing about tokens, tenants or cookies when those features are off', () => {
      const plain = buildSwaggerDocument(app, options, { betterAuth: false });
      expect(plain.security).toEqual([{ bearer: [] }]);
      expect(plain.components?.securitySchemes?.cookie).toBeUndefined();
      expect(plain.components?.parameters?.[SWAGGER_TENANT_HEADER_PARAMETER]).toBeUndefined();
      const list = operation(plain, '/items', 'get');
      expect(list[SWAGGER_API_TOKEN_SCOPES_EXTENSION]).toBeUndefined();
      expect(list.description ?? '').not.toContain('API tokens');
      expect(hasTenantHeader(list)).toBe(false);
      // Public is decided by the roles alone without multi-tenancy — the default of the framework.
      expect(list.security).toBeUndefined();
      expect(operation(plain, '/internal', 'get').security).toBeUndefined();
      expect(operation(plain, '/mixed/open', 'get').security).toEqual([]);
    });

    it('enriches a handler that serves several paths', () => {
      for (const path of ['/items/archive', '/items/history']) {
        expect(operation(document, path, 'get')[SWAGGER_API_TOKEN_SCOPES_EXTENSION]).toEqual(['read']);
        expect(hasTenantHeader(operation(document, path, 'get'))).toBe(true);
      }
    });

    it('retags operations by use case and orders the tags as configured', () => {
      const tagged = buildSwaggerDocument(
        app,
        {
          ...options,
          operationTags: ({ controller, scopes }) =>
            controller === 'InternalController' ? ['Administration'] : scopes ? ['Integration'] : undefined,
          tags: [{ description: 'Routes for API tokens', name: 'Integration' }, { name: 'Administration' }],
        },
        fullConfig,
      );
      expect(operation(tagged, '/items', 'get').tags).toEqual(['Integration']);
      expect(operation(tagged, '/internal', 'get').tags).toEqual(['Administration']);
      expect(tagged.tags?.map((tag) => tag.name)).toEqual(['Integration', 'Administration', 'Mixed']);
      expect(tagged.tags?.[0].description).toBe('Routes for API tokens');
    });
  });

  describe('API-token view', () => {
    let view: OpenAPIObject;

    beforeAll(() => {
      view = buildApiTokenSwaggerDocument(
        buildSwaggerDocument(app, options, companyTokensOnly),
        options.apiTokenView,
        companyTokensOnly,
      );
    });

    it('keeps only the routes a token may call', () => {
      expect(Object.keys(view.paths)).toEqual(['/items', '/items/archive', '/items/history']);
      expect(Object.keys(view.paths['/items'])).toEqual(['get', 'post']);
    });

    it('authenticates with the bearer scheme only and, with company tokens only, drops the tenant header', () => {
      expect(view.info.title).toBe('Partner API');
      expect(view.security).toEqual([{ bearer: [] }]);
      expect(Object.keys(view.components?.securitySchemes ?? {})).toEqual(['bearer']);
      expect(operation(view, '/items', 'get').security).toEqual([{ bearer: [] }]);
      expect(hasTenantHeader(operation(view, '/items', 'get'))).toBe(false);
      expect(view.components?.parameters?.[SWAGGER_TENANT_HEADER_PARAMETER]).toBeUndefined();
    });

    it('drops schemas no remaining route refers to', () => {
      expect(Object.keys(view.components?.schemas ?? {})).toEqual(['ItemOutput']);
    });

    it('keeps the tenant header while personal tokens exist — they choose the company like a session', () => {
      const withUserTokens = buildApiTokenSwaggerDocument(
        buildSwaggerDocument(app, options, fullConfig),
        options.apiTokenView,
        fullConfig,
      );
      expect(hasTenantHeader(operation(withUserTokens, '/items', 'get'))).toBe(true);
      expect(withUserTokens.components?.parameters?.[SWAGGER_TENANT_HEADER_PARAMETER]).toMatchObject({
        description: expect.stringContaining('A personal API token chooses the company like a session'),
      });
    });
  });

  describe('setupSwagger', () => {
    let served: INestApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({ imports: [SwaggerTestModule] }).compile();
      served = moduleRef.createNestApplication();
      setupSwagger(served, { ...options, jsonDocumentUrl: '/docs-json' });
      await served.init();
    });

    afterAll(async () => {
      await served?.close();
    });

    it('serves the full document and the API-token view under their own paths', async () => {
      const full = await request(served.getHttpServer()).get('/docs-json').expect(200);
      expect(full.body.info.title).toBe('Test');

      const view = await request(served.getHttpServer()).get('/api-docs-api-tokens-json').expect(200);
      expect(view.body.info.title).toBe('Partner API');

      await request(served.getHttpServer()).get('/swagger-partner').expect(200);
    });
  });

  describe('a handler for every HTTP method (@All)', () => {
    let relayApp: INestApplication;
    let document: OpenAPIObject;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({ imports: [RelayTestModule] }).compile();
      relayApp = moduleRef.createNestApplication();
      await relayApp.init();
      document = buildSwaggerDocument(relayApp, options, fullConfig);
    });

    afterAll(async () => {
      await relayApp?.close();
    });

    it('enriches every operation it produces, SEARCH included', () => {
      const operations = Object.entries(document.paths['/relay'] ?? {});
      expect(operations.map(([method]) => method)).toContain('search');
      for (const [method, op] of operations as [string, OperationObject & Record<string, any>][]) {
        expect(op[SWAGGER_API_TOKEN_SCOPES_EXTENSION], method).toEqual(['read']);
        expect(op.description, method).toContain('**API tokens:** allowed with scope `read`.');
        expect(hasTenantHeader(op), method).toBe(true);
      }
    });

    it('retags SEARCH like every other method', () => {
      // Not 'Relay': autoTagControllers already gives every operation that tag, so it would pass unretagged.
      const tagged = buildSwaggerDocument(relayApp, { ...options, operationTags: () => ['Integration'] }, fullConfig);
      for (const [method, op] of Object.entries(tagged.paths['/relay'] ?? {}) as [string, OperationObject][]) {
        expect(op.tags, method).toEqual(['Integration']);
      }
    });

    it('treats SEARCH as an operation in the API-token view, not as a field of the path', () => {
      const view = buildApiTokenSwaggerDocument(document, {}, fullConfig);
      const search = view.paths['/relay']?.['search' as 'get'] as (OperationObject & Record<string, any>) | undefined;
      expect(search?.[SWAGGER_API_TOKEN_SCOPES_EXTENSION]).toEqual(['read']);
      expect(search?.security).toEqual([{ bearer: [] }]);
    });
  });

  describe('framework routes', () => {
    it('keeps the Better-Auth pass-through (`@All` under /iam) out of the document', async () => {
      // Every collaborator is replaced by a stub: only the controller's routes and metadata matter here.
      const stub = new Proxy(
        {},
        {
          get: (_target, prop) =>
            prop === 'then' || typeof prop === 'symbol' ? undefined : prop === 'getBasePath' ? () => '/iam' : () => undefined,
        },
      );
      const moduleRef = await Test.createTestingModule({ controllers: [CoreBetterAuthController] })
        .useMocker(() => stub)
        .compile();
      const iamApp = moduleRef.createNestApplication();
      await iamApp.init();
      try {
        const document = buildSwaggerDocument(iamApp, options, { betterAuth: false });
        const paths = Object.keys(document.paths);
        expect(paths.some((path) => path.startsWith('/iam/'))).toBe(true);
        expect(paths).not.toContain('/iam/{path}');
      } finally {
        await iamApp.close();
      }
    });
  });
});
