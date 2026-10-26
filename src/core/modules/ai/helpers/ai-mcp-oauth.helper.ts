import { Logger } from '@nestjs/common';

import { resolveServerUrls } from '../../../common/helpers/cookies.helper.js';
import { ConfigService } from '../../../common/services/config.service.js';
import { CoreAiMcpOAuthService } from '../services/core-ai-mcp-oauth.service.js';
import { IMountedMcpOAuth, setMountedMcpOAuth } from './ai-mcp-oauth.registry.js';

const logger = new Logger('mountAiMcpOAuth');

/**
 * What is mounted where, keyed on the Express instance (or, for an app without an HTTP adapter, on
 * the object handed in). Shared by `CoreAiMcpOAuthInitializer` and {@link mountAiMcpOAuth}, so the
 * router is mounted once per app no matter which of them gets there first. Holds the PENDING mount:
 * building the router awaits a dynamic import, and a second caller arriving meanwhile must wait for
 * the first instead of passing the check too.
 */
const mountedTargets = new WeakMap<object, Promise<IMountedMcpOAuth>>();

/** The app shape {@link mountAiMcpOAuth} accepts: a Nest application or anything with `get` + `use`. */
export interface IAiMcpOAuthMountTarget {
  get: (token: any) => any;
  getHttpAdapter?: () => { getInstance?: () => unknown } | undefined;
  use: (...args: any[]) => any;
}

/** Where the OAuth router goes and what it advertises. */
export interface IAiMcpOAuthRouterOptions {
  /** Path the IAM endpoints answer under, for the consent page's sign-in (see `IMountedMcpOAuth`). */
  authBasePath?: string;
  /**
   * Public base URL of this server, when it differs from `baseUrl` — the issuer and the host of
   * the MCP resource. Blank, or anything but a string (config arrives as JSON), counts as absent.
   */
  baseUrl?: unknown;
  /** Where `baseUrl` came from, for error messages and the boot log. */
  baseUrlSource?: string;
  /** Path of the MCP endpoint, as Nest registered it. */
  mcpPath: string;
}

/**
 * Mount the MCP OAuth 2.1 router (`mcpAuthRouter`) on a NestJS application.
 *
 * @deprecated Since 11.43.0 `CoreModule` mounts the OAuth endpoints itself when `ai.mcp.oauth` is
 * enabled (`CoreAiMcpOAuthInitializer`): during `app.init()`, behind the Nest middleware and ahead of
 * Nest's not-found handler. Called on an app where that already happened, this is a no-op. The call
 * this replaces — after `app.init()`, as the documentation used to say — never worked in a Nest
 * application: Nest registers its not-found handler inside `init()`, so a router added afterwards
 * was never reached and every OAuth endpoint answered 404.
 *
 * Still mounts when nothing mounted the router yet, e.g. on an app built without `CoreModule`'s AI
 * module, or when called BEFORE `app.init()` (the router then sits in front of every Nest
 * middleware). Options the automatic mount derives — `baseUrl` from `ai.mcp.oauthBaseUrl`, the MCP
 * path from the controller's route — are ignored with a warning when the router is already mounted.
 *
 * The base URL must be the server's public URL: it becomes the OAuth issuer and every endpoint in
 * the discovery metadata, and MCP clients follow those URLs. Resolution order:
 *
 * 1. `options.baseUrl`, when non-blank — for an issuer that differs from `baseUrl`
 * 2. `baseUrl` from the server config (`NSC__BASE_URL` in deployed environments)
 * 3. `http://localhost:3000` in `local` / `ci` / `e2e` only
 * 4. otherwise the call throws — it never guesses
 *
 * Steps 2 and 3 are `resolveServerUrls()`, the resolver BetterAuth and CORS use, so the issuer
 * agrees with the URL the rest of the server believes it has. Step 4 is the point: a deployed API
 * that advertised `http://localhost:3000` made Claude Code try to register the client on the
 * user's own machine (`ECONNREFUSED`).
 */
export async function mountAiMcpOAuth(
  app: IAiMcpOAuthMountTarget,
  options: { baseUrl?: string; mcpPath?: string } = {},
): Promise<void> {
  const target = mountTargetOf(app);
  const existing = mountedTargets.get(target);
  if (existing) {
    reportRedundantMount(await existing, options);
    return;
  }
  await mountAiMcpOAuthRouter(target, (router) => app.use(router), app.get(CoreAiMcpOAuthService), {
    baseUrl: options.baseUrl,
    baseUrlSource: 'options.baseUrl',
    mcpPath: options.mcpPath ?? '/ai/mcp',
  });
}

/**
 * Builds the OAuth router for `oauthService` and mounts it with `use` — once per `target`.
 *
 * Returns what is mounted on `target`: the new mount, or the one already there (then `use` is not
 * called). The mount is recorded for `setupSwagger()` and for the MCP controller's 401 answer.
 */
export async function mountAiMcpOAuthRouter(
  target: object,
  use: (router: unknown) => void,
  oauthService: CoreAiMcpOAuthService,
  options: IAiMcpOAuthRouterOptions,
): Promise<IMountedMcpOAuth> {
  const existing = mountedTargets.get(target);
  if (existing) {
    return existing;
  }
  const pending = mountRouter(use, oauthService, options);
  mountedTargets.set(target, pending);
  try {
    return await pending;
  } catch (error) {
    // A failed mount mounted nothing; a later attempt must not inherit the failure.
    mountedTargets.delete(target);
    throw error;
  }
}

/** Resolves the issuer, builds the router and mounts it — the part {@link mountAiMcpOAuthRouter} runs once. */
async function mountRouter(
  use: (router: unknown) => void,
  oauthService: CoreAiMcpOAuthService,
  options: IAiMcpOAuthRouterOptions,
): Promise<IMountedMcpOAuth> {
  const { baseUrl, source } = resolveMcpOAuthBaseUrl(options.baseUrl, options.baseUrlSource ?? 'options.baseUrl');
  const issuerUrl = parseAbsoluteUrl(baseUrl, source);
  const resourceServerUrl = new URL(`${baseUrl.replace(/\/$/, '')}${options.mcpPath}`);
  const { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } =
    await import('@modelcontextprotocol/sdk/server/auth/router.js');
  const provider = oauthService.buildOAuthProvider() as any;

  let router: unknown;
  try {
    router = mcpAuthRouter({ issuerUrl, provider, resourceServerUrl });
  } catch (error) {
    // The SDK's refusals ("Issuer URL must be HTTPS") do not say which URL they refused. Now
    // that the URL can come from config rather than from the call site, that is the one thing
    // an operator needs to know.
    const reason = (error as Error).message;
    throw new Error(`mountAiMcpOAuth: OAuth issuer "${baseUrl}" (from ${source}) rejected: ${reason}`, {
      cause: error,
    });
  }

  use(router);
  const mounted: IMountedMcpOAuth = {
    authBasePath: options.authBasePath,
    baseUrl: baseUrl.replace(/\/$/, ''),
    issuerUrl: issuerUrl.href,
    mcpPath: options.mcpPath,
    // The same conditions mcpAuthRouter() uses to decide whether /register and /revoke exist.
    registration: !!provider?.clientsStore?.registerClient,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
    resourceUrl: resourceServerUrl.href,
    revocation: !!provider?.revokeToken,
  };
  setMountedMcpOAuth(mounted);
  logger.log(`MCP OAuth issuer: ${issuerUrl.href} (from ${source}), resource: ${resourceServerUrl.href}`);
  return mounted;
}

/** The Express instance behind a Nest application, or the object itself for any other shape. */
function mountTargetOf(app: IAiMcpOAuthMountTarget): object {
  const instance = app.getHttpAdapter?.()?.getInstance?.();
  return (typeof instance === 'object' && instance !== null) || typeof instance === 'function'
    ? (instance as object)
    : app;
}

/** A second mount on the same app changes nothing — say so, and name what was ignored. */
function reportRedundantMount(mounted: IMountedMcpOAuth, options: { baseUrl?: string; mcpPath?: string }): void {
  const ignored: string[] = [];
  const baseUrl = options.baseUrl?.trim().replace(/\/$/, '');
  if (baseUrl && baseUrl !== mounted.baseUrl) {
    ignored.push(`baseUrl "${options.baseUrl}" (mounted: "${mounted.baseUrl}"; set ai.mcp.oauthBaseUrl instead)`);
  }
  if (options.mcpPath && options.mcpPath !== mounted.mcpPath) {
    ignored.push(
      `mcpPath "${options.mcpPath}" (mounted: "${mounted.mcpPath}", derived from the MCP controller's route)`,
    );
  }
  if (ignored.length) {
    logger.warn(`The MCP OAuth router is already mounted; this call changed nothing and ignored ${ignored.join(', ')}`);
    return;
  }
  logger.log(
    'The MCP OAuth router is already mounted (CoreModule mounts it when ai.mcp.oauth is enabled); this call can be removed',
  );
}

/**
 * Resolves the issuer base URL. A blank `explicit` value counts as absent, because
 * `BASE_URL=` in an env file yields `''`, not `undefined`.
 */
function resolveMcpOAuthBaseUrl(explicit: unknown, explicitSource: string): { baseUrl: string; source: string } {
  const given = typeof explicit === 'string' ? explicit.trim() : undefined;
  if (given) {
    return { baseUrl: given, source: explicitSource };
  }

  const config = ConfigService.configFastButReadOnly;
  const resolved = resolveServerUrls({ baseUrl: config?.baseUrl, env: config?.env });
  if (resolved.baseUrl) {
    return {
      baseUrl: resolved.baseUrl,
      source:
        resolved.baseUrlSource === 'localhost-default' ? `localhost default (env: ${config?.env})` : 'config.baseUrl',
    };
  }

  throw new Error(
    `mountAiMcpOAuth: no public server URL for the OAuth issuer (env: ${config?.env ?? 'unset'}). ` +
      'Set `baseUrl` in the server config (NSC__BASE_URL) or `ai.mcp.oauthBaseUrl`. ' +
      'A guessed localhost URL would send MCP clients to their own machine.',
  );
}

function parseAbsoluteUrl(value: string, source: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`mountAiMcpOAuth: "${value}" (from ${source}) is not an absolute URL`);
  }
}
