import { Logger } from '@nestjs/common';

import { resolveServerUrls } from '../../../common/helpers/cookies.helper';
import { ConfigService } from '../../../common/services/config.service';
import { CoreAiMcpOAuthService } from '../services/core-ai-mcp-oauth.service';

/**
 * Mount the MCP OAuth 2.1 router (`mcpAuthRouter`) on a NestJS application.
 *
 * Call this in `main.ts` AFTER `app.init()` when `ai.mcp.oauth` is enabled. It
 * lazy-imports `@modelcontextprotocol/sdk` and wires the OAuth provider built from
 * {@link CoreAiMcpOAuthService}, exposing the standard discovery + token endpoints
 * (`/.well-known/oauth-*`, `/authorize`, `/token`, `/register`, `/revoke`).
 *
 * The interactive consent step requires `CoreAiMcpOAuthService.authorizeConsent`
 * to be overridden with your login/consent UI (see INTEGRATION-CHECKLIST).
 *
 * The base URL must be the server's public URL: it becomes the OAuth issuer and
 * every endpoint in the discovery metadata, and MCP clients follow those URLs.
 * Resolution order:
 *
 * 1. `options.baseUrl`, when non-blank — for an issuer that differs from `baseUrl`
 * 2. `baseUrl` from the server config (`NSC__BASE_URL` in deployed environments)
 * 3. `http://localhost:3000` in `local` / `ci` / `e2e` only
 * 4. otherwise the call throws — it never guesses
 *
 * Steps 2 and 3 are `resolveServerUrls()`, the resolver BetterAuth and CORS use, so
 * the issuer agrees with the URL the rest of the server believes it has. Step 4 is
 * the point: a deployed API that advertised `http://localhost:3000` made Claude Code
 * try to register the client on the user's own machine (`ECONNREFUSED`).
 *
 * @example
 * ```typescript
 * // main.ts, after app.init()
 * await mountAiMcpOAuth(app);
 * ```
 */
export async function mountAiMcpOAuth(
  app: { get: (token: any) => any; use: (...args: any[]) => any },
  options: { baseUrl?: string; mcpPath?: string } = {},
): Promise<void> {
  const { baseUrl, source } = resolveMcpOAuthBaseUrl(options.baseUrl);
  const issuerUrl = parseAbsoluteUrl(baseUrl, source);
  const { mcpAuthRouter } = await import('@modelcontextprotocol/sdk/server/auth/router.js');
  const oauthService: CoreAiMcpOAuthService = app.get(CoreAiMcpOAuthService);
  const mcpPath = options.mcpPath ?? '/ai/mcp';

  let router: unknown;
  try {
    router = mcpAuthRouter({
      issuerUrl,
      provider: oauthService.buildOAuthProvider() as any,
      resourceServerUrl: new URL(`${baseUrl.replace(/\/$/, '')}${mcpPath}`),
    });
  } catch (error) {
    // The SDK's refusals ("Issuer URL must be HTTPS") do not say which URL they refused. Now
    // that the URL can come from config rather than from the call site, that is the one thing
    // an operator needs to know.
    const reason = (error as Error).message;
    throw new Error(`mountAiMcpOAuth: OAuth issuer "${baseUrl}" (from ${source}) rejected: ${reason}`, {
      cause: error,
    });
  }

  app.use(router);
  new Logger('mountAiMcpOAuth').log(`MCP OAuth issuer: ${issuerUrl.href} (from ${source})`);
}

/**
 * Resolves the issuer base URL. A blank `explicit` value counts as absent, because
 * `BASE_URL=` in an env file yields `''`, not `undefined`.
 */
function resolveMcpOAuthBaseUrl(explicit: string | undefined): { baseUrl: string; source: string } {
  const given = explicit?.trim();
  if (given) {
    return { baseUrl: given, source: 'options.baseUrl' };
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
      'Set `baseUrl` in the server config (NSC__BASE_URL) or pass `options.baseUrl`. ' +
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
