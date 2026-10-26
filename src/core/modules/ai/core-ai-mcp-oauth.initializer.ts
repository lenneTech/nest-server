import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  OnModuleInit,
  Optional,
  RequestMethod,
} from '@nestjs/common';
import { MODULE_PATH, PATH_METADATA, VERSION_METADATA } from '@nestjs/common/constants';
import { addLeadingSlash } from '@nestjs/common/utils/shared.utils';
import { ApplicationConfig, HttpAdapterHost, ModuleRef, ModulesContainer } from '@nestjs/core';
import { RoutePathFactory } from '@nestjs/core/router/route-path-factory';

import { ConfigService } from '../../common/services/config.service.js';
import { getBetterAuthTokenService } from '../better-auth/core-better-auth.registry.js';
import { CoreAiMcpController } from './core-ai-mcp.controller.js';
import { mountAiMcpOAuthRouter } from './helpers/ai-mcp-oauth.helper.js';
import { getMountedMcpOAuth, IMountedMcpOAuth, setMountedMcpOAuth } from './helpers/ai-mcp-oauth.registry.js';
import { CoreAiMcpOAuthService } from './services/core-ai-mcp-oauth.service.js';

/**
 * Mounts the MCP OAuth 2.1 endpoints (`/.well-known/oauth-*`, `/authorize`, `/token`, `/register`)
 * when `ai.mcp.oauth` is enabled — no `main.ts` code, and the same under `Test.createTestingModule()`.
 *
 * WHERE in the lifecycle is the whole point. The endpoints are an Express router, not Nest routes,
 * and Nest registers its not-found handler inside `app.init()`, after `onModuleInit`. A router added
 * after `app.init()` — what the documentation used to prescribe — sits behind that handler and is
 * never reached: every OAuth endpoint answered 404. Mounted here, it sits behind every Nest
 * middleware (security headers, request context, CORS) and the Nest routes, and ahead of the
 * not-found handler.
 *
 * The MCP resource path is computed the way Nest computes the controller's route (global prefix and
 * its exclusions, URI versioning, a `RouterModule` path), so the protected resource metadata names
 * the URL the MCP endpoint actually answers on. The issuer is `ai.mcp.oauthBaseUrl`, else the
 * server's `baseUrl`; a deployed environment without either fails the boot rather than advertising
 * a guessed URL.
 *
 * Registered by `CoreAiModule` whenever the MCP endpoint is; consumers never interact with it.
 */
@Injectable()
export class CoreAiMcpOAuthInitializer implements OnApplicationBootstrap, OnApplicationShutdown, OnModuleInit {
  protected readonly logger = new Logger(CoreAiMcpOAuthInitializer.name);

  /** What this instance mounted, so shutdown clears only its own record. */
  private mounted?: IMountedMcpOAuth;

  constructor(
    protected readonly oauthService: CoreAiMcpOAuthService,
    @Optional() protected readonly httpAdapterHost?: HttpAdapterHost,
    @Optional() protected readonly moduleRef?: ModuleRef,
    @Optional() protected readonly modulesContainer?: ModulesContainer,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.oauthService.isOAuthEnabled()) {
      return;
    }
    const adapter = this.httpAdapterHost?.httpAdapter;
    if (!adapter) {
      // An application context without an HTTP server (CLI, migration script): nothing to serve.
      return;
    }
    // Repeated here, in framework code, because a subclass may override onModuleInit() without super.
    this.oauthService.assertProductionSafe();
    if (adapter.getType() !== 'express') {
      throw new Error(
        `ai.mcp.oauth requires the Express adapter, but the application runs on "${adapter.getType()}": ` +
          'the MCP OAuth endpoints are an Express router.',
      );
    }

    this.mounted = await mountAiMcpOAuthRouter(
      adapter.getInstance(),
      (router) => adapter.use(router),
      this.oauthService,
      {
        baseUrl: ConfigService.get<unknown>('ai.mcp.oauthBaseUrl'),
        authBasePath: this.resolveAuthBasePath(),
        baseUrlSource: 'ai.mcp.oauthBaseUrl',
        mcpPath: this.resolveMcpPath(),
      },
    );
  }

  /**
   * The built-in consent page signs users in through Better-Auth. Checked at bootstrap, when every
   * module — Better-Auth's included — has initialized.
   */
  onApplicationBootstrap(): void {
    if (!this.mounted || !this.oauthService.usesBuiltInConsent() || getBetterAuthTokenService()) {
      return;
    }
    this.logger.warn(
      'ai.mcp.oauth is enabled, but Better-Auth is not active: the built-in consent page has no way to sign a user ' +
        'in, so no MCP client can be authorized. Enable betterAuth, or register a CoreAiMcpOAuthService subclass ' +
        'with an authorizeConsent() of your own via CoreModule.forRoot(env, { ai: { mcpOAuthService } }).',
    );
  }

  onApplicationShutdown(): void {
    if (this.mounted && getMountedMcpOAuth() === this.mounted) {
      setMountedMcpOAuth(undefined);
    }
  }

  /**
   * The path the MCP endpoint (`POST` on `CoreAiMcpController`) is registered at, computed with
   * Nest's own `RoutePathFactory` from the inputs Nest passes it (`NestApplication.registerRouter`,
   * `RoutesResolver`). Re-implementing the rules instead would drift silently the first time Nest
   * changes one; this breaks loudly, and `tests/unit/ai-mcp-oauth-lifecycle.spec.ts` pins the result
   * against the route the controller actually answers on.
   */
  protected resolveMcpPath(): string {
    const container = (this.moduleRef as unknown as { container?: { applicationConfig?: ApplicationConfig } })
      ?.container;
    const applicationConfig = container?.applicationConfig;
    const ctrlPath = this.controllerPath();
    if (!applicationConfig) {
      return ctrlPath;
    }

    const versioningOptions = applicationConfig.getVersioning();
    const controllerVersion = versioningOptions
      ? (Reflect.getMetadata(VERSION_METADATA, CoreAiMcpController) ?? versioningOptions.defaultVersion)
      : undefined;
    const paths = new RoutePathFactory(applicationConfig).create(
      {
        controllerVersion,
        ctrlPath,
        globalPrefix: addLeadingSlash(applicationConfig.getGlobalPrefix()),
        methodPath: '/',
        modulePath: this.modulePath(),
        versioningOptions,
      },
      RequestMethod.POST,
    );

    if (paths.length > 1) {
      this.logger.warn(
        `The MCP endpoint is registered at ${paths.join(', ')}; the OAuth metadata describes the first one only.`,
      );
    }
    return paths[0];
  }

  /**
   * Where the IAM endpoints the consent page signs in through answer: Better-Auth's `basePath` below
   * the global prefix (and URI version) Nest registers the IAM controller under. The OAuth router
   * itself sits at the root, so a page served there must not assume `/iam`.
   */
  protected resolveAuthBasePath(): string {
    const basePath = `/${String(ConfigService.get<string>('betterAuth.basePath') || 'iam').replace(/^\//, '')}`;
    const applicationConfig = (this.moduleRef as unknown as { container?: { applicationConfig?: ApplicationConfig } })
      ?.container?.applicationConfig;
    if (!applicationConfig) {
      return basePath;
    }
    const versioningOptions = applicationConfig.getVersioning();
    const [signIn] = new RoutePathFactory(applicationConfig).create(
      {
        controllerVersion: versioningOptions?.defaultVersion,
        ctrlPath: basePath,
        globalPrefix: addLeadingSlash(applicationConfig.getGlobalPrefix()),
        methodPath: '/sign-in/email',
        versioningOptions,
      },
      RequestMethod.POST,
    );
    return signIn.replace(/\/sign-in\/email$/, '');
  }

  /** The controller's declared route, with a leading slash (`/ai/mcp`). */
  private controllerPath(): string {
    const declared = Reflect.getMetadata(PATH_METADATA, CoreAiMcpController);
    const path = Array.isArray(declared) ? declared[0] : declared;
    return `/${String(path ?? 'ai/mcp').replace(/^\//, '')}`;
  }

  /**
   * A `RouterModule` path in front of the module that registered the MCP controller, read the way
   * `RoutesResolver` reads it. The module is looked up rather than imported: importing `CoreAiModule`
   * here would put this file and the module on an import cycle.
   */
  private modulePath(): string | undefined {
    if (!this.modulesContainer) {
      return undefined;
    }
    for (const module of this.modulesContainer.values()) {
      if (module.controllers.has(CoreAiMcpController)) {
        return (
          Reflect.getMetadata(MODULE_PATH + this.modulesContainer.applicationId, module.metatype) ??
          Reflect.getMetadata(MODULE_PATH, module.metatype)
        );
      }
    }
    return undefined;
  }
}
