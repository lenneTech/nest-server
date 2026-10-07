import { All, Controller, Get, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { openAPI, twoFactor } from 'better-auth/plugins';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ApiMethods } from '../../src/core/common/decorators/api-methods.decorator';
import { Roles } from '../../src/core/common/decorators/roles.decorator';
import { RoleEnum } from '../../src/core/common/enums/role.enum';
import { buildSwaggerDocument } from '../../src/core/common/helpers/swagger.helper';
import { CoreAiMcpController } from '../../src/core/modules/ai/core-ai-mcp.controller';
import { setMountedMcpOAuth } from '../../src/core/modules/ai/helpers/ai-mcp-oauth.registry';
import { CoreAuthController } from '../../src/core/modules/auth/core-auth.controller';
import { CoreBetterAuthController } from '../../src/core/modules/better-auth/core-better-auth.controller';
import { CoreBetterAuthService } from '../../src/core/modules/better-auth/core-better-auth.service';
import { CoreHubController } from '../../src/core/modules/hub/core-hub.controller';

import type { Provider, Type } from '@nestjs/common';
import type { OpenAPIObject, OperationObject } from '@nestjs/swagger';
import type { IServerOptions } from '../../src/core/common/interfaces/server-options.interface';
import type { IBetterAuthOpenApiDocument } from '../../src/core/modules/better-auth/core-better-auth-openapi.helper';

/**
 * The document lists every operation that can succeed under the running configuration, and only those.
 * Each case pairs the switch that takes an operation out with the setting that keeps it in, so a rule
 * that silently stopped firing — or fired always — turns one of the two red.
 */

/** A stub for every collaborator: only routes and metadata matter here. */
function stub(overrides: Record<string, unknown> = {}) {
  return new Proxy(
    {},
    {
      get: (_target, prop) =>
        prop === 'then' || typeof prop === 'symbol'
          ? undefined
          : prop in overrides
            ? overrides[prop as string]
            : prop === 'getBasePath'
              ? () => '/iam'
              : () => undefined,
    },
  );
}

async function documentOf(
  controllers: Type<unknown>[],
  config: Partial<IServerOptions>,
  setup: { globalPrefix?: string; providers?: Provider[] } = {},
): Promise<OpenAPIObject> {
  const moduleRef = await Test.createTestingModule({ controllers, providers: setup.providers ?? [] })
    .useMocker(() => stub())
    .compile();
  const app = moduleRef.createNestApplication();
  if (setup.globalPrefix) {
    app.setGlobalPrefix(setup.globalPrefix);
  }
  await app.init();
  try {
    return buildSwaggerDocument(app, { title: 'Availability' }, config);
  } finally {
    await app.close();
  }
}

const methodsOf = (document: OpenAPIObject, path: string) => Object.keys(document.paths[path] ?? {}).sort();

/** A project's Better-Auth controller with a route of its own — parametrized, like most real ones. */
@Controller('iam')
class ProjectBetterAuthController extends CoreBetterAuthController {
  @Get('users/:id/sessions')
  @Roles(RoleEnum.ADMIN)
  userSessions(): void {}
}

@Controller('uploads')
@Roles(RoleEnum.S_USER)
class UploadController {
  @All(':id')
  @ApiMethods('head', 'patch', 'delete')
  handle(): void {}
}

@Module({ controllers: [UploadController] })
class UploadModule {}

describe('@ApiMethods on an @All() handler', () => {
  it('documents only the methods the handler serves', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [UploadModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      const document = buildSwaggerDocument(app, { title: 'Availability' }, {});
      // Without @ApiMethods @nestjs/swagger documents eight operations here.
      expect(methodsOf(document, '/uploads/{id}')).toEqual(['delete', 'head', 'patch']);
    } finally {
      await app.close();
    }
  });
});

describe('legacy auth REST endpoints', () => {
  const legacyPaths = ['/auth/logout', '/auth/refresh-token', '/auth/signin', '/auth/signup'];

  it('are left out while auth.legacyEndpoints keeps REST closed (the default since 11.38.0)', async () => {
    for (const config of [{}, { auth: { legacyEndpoints: { enabled: false } } }, { auth: { legacyEndpoints: { rest: false } } }]) {
      const paths = Object.keys((await documentOf([CoreAuthController], config as Partial<IServerOptions>)).paths);
      legacyPaths.forEach((path) => expect(paths, `${JSON.stringify(config)} ${path}`).not.toContain(path));
    }
  });

  it('are documented once they are opened', async () => {
    const paths = Object.keys(
      (await documentOf([CoreAuthController], { auth: { legacyEndpoints: { enabled: true } } })).paths,
    );
    legacyPaths.forEach((path) => expect(paths, path).toContain(path));
  });
});

describe('Hub endpoints', () => {
  it('leave out what a switched-off panel answers with `{ available: false }`', async () => {
    const document = await documentOf([CoreHubController], {
      hub: { collectors: { logs: false }, db: false, emailPreview: false, migrations: false },
    });
    const paths = Object.keys(document.paths);
    for (const path of ['/logs.json', '/db.json', '/emails.json', '/emails/preview', '/migrations.json']) {
      expect(paths, path).not.toContain(path);
    }
    // Off by default: the query profiler and the mailbox.
    expect(paths).not.toContain('/queries.json');
    expect(paths).not.toContain('/mailbox.json');
    // Unaffected panels stay.
    expect(paths).toContain('/dashboard.json');
  });

  it('keep what is switched on', async () => {
    const document = await documentOf([CoreHubController], {
      hub: { collectors: { queries: true } },
    });
    const paths = Object.keys(document.paths);
    for (const path of ['/logs.json', '/traces.json', '/queries.json', '/db.json', '/emails.json', '/migrations.json']) {
      expect(paths, path).toContain(path);
    }
  });
});

describe('MCP', () => {
  afterEach(() => setMountedMcpOAuth(undefined));

  it('documents /ai/mcp with the bearer requirement it enforces itself', async () => {
    const document = await documentOf([CoreAiMcpController], {});
    expect(methodsOf(document, '/ai/mcp')).toEqual(['delete', 'get', 'post']);
    // The route guard admits everybody; the explicit @ApiBearerAuth() keeps it from reading as public.
    expect((document.paths['/ai/mcp'].post as OperationObject).security).toEqual([{ bearer: [] }]);
  });

  it('documents exactly the OAuth endpoints mountAiMcpOAuth() mounted', async () => {
    expect(Object.keys((await documentOf([UploadController], {})).paths)).not.toContain('/token');

    setMountedMcpOAuth({ mcpPath: '/ai/mcp', registration: true, revocation: false });
    const paths = Object.keys((await documentOf([UploadController], {})).paths);
    for (const path of [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-protected-resource/ai/mcp',
      '/authorize',
      '/token',
      '/register',
    ]) {
      expect(paths, path).toContain(path);
    }
    expect(paths).not.toContain('/revoke');
  });
});

describe('Better-Auth routes', () => {
  let schema: IBetterAuthOpenApiDocument;

  beforeAll(async () => {
    const auth = betterAuth({
      basePath: '/iam',
      baseURL: 'http://localhost:3000',
      database: memoryAdapter({}),
      emailAndPassword: { enabled: true },
      logger: { disabled: true },
      plugins: [twoFactor({ issuer: 'Availability spec' }), openAPI({ disableDefaultReference: true })],
      secret: 'swagger-availability-spec-secret-4e2b9d17a6c3',
    });
    schema = (await auth.api.generateOpenAPISchema()) as unknown as IBetterAuthOpenApiDocument;
  });

  const service = (overrides: Record<string, unknown>) => ({ provide: CoreBetterAuthService, useValue: stub(overrides) });

  it('applies what the live instance refuses to the controller routes too (betterAuth.options pass-through)', async () => {
    // Sign-up switched off through betterAuth.options, which the nest-server config does not show.
    const off = await documentOf([CoreBetterAuthController], {}, {
      providers: [service({ getUnavailableOperations: () => new Set(['/sign-up/email']) })],
    });
    expect(Object.keys(off.paths)).not.toContain('/iam/sign-up/email');

    const on = await documentOf([CoreBetterAuthController], {}, {
      providers: [service({ getUnavailableOperations: () => new Set() })],
    });
    expect(Object.keys(on.paths)).toContain('/iam/sign-up/email');
  });

  it('leaves out an unavailable method of a generated route, keeping the others', async () => {
    const document = await documentOf([CoreBetterAuthController], {}, {
      providers: [
        service({ getOpenApiSchema: () => schema, getUnavailableOperations: () => new Set(['post /get-session']) }),
      ],
    });
    expect(methodsOf(document, '/iam/get-session')).toEqual(['get']);
  });

  /**
   * @regression   11.42.9 (pre-release review) — a parametrized route on the project's Better-Auth
   *   controller was read as a relocated controller, because its declared path
   *   (`/iam/users/:id/sessions`) never equals the document's (`/iam/users/{id}/sessions`). Every route
   *   Better-Auth serves itself then left the document, with a warning blaming a global prefix.
   * @seen-failing Compare the full declared route path again in buildSwaggerDocument()
   *   (src/core/common/helpers/swagger.helper.ts) — registered as mutation
   *   `swagger-relocation-full-path` in tests/regression-mutations.json.
   */
  it('keeps the generated routes when the project controller has parametrized routes of its own', async () => {
    const document = await documentOf([ProjectBetterAuthController], {}, {
      providers: [service({ getOpenApiSchema: () => schema })],
    });
    const paths = Object.keys(document.paths);
    expect(paths).toContain('/iam/users/{id}/sessions');
    expect(paths).toContain('/iam/two-factor/enable');
  });

  it('documents no generated route under a global prefix, where none of them is reachable', async () => {
    const document = await documentOf([CoreBetterAuthController], {}, {
      globalPrefix: 'api',
      providers: [service({ getOpenApiSchema: () => schema })],
    });
    const paths = Object.keys(document.paths);
    expect(paths).toContain('/api/iam/session');
    expect(paths.some((path) => path.includes('two-factor'))).toBe(false);
    expect(paths.some((path) => path.includes('get-session'))).toBe(false);
  });
});
