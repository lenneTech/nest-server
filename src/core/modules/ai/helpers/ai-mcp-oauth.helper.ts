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
 * @example
 * ```typescript
 * // main.ts, after app.init()
 * await mountAiMcpOAuth(app, { baseUrl: process.env.BASE_URL });
 * ```
 */
export async function mountAiMcpOAuth(
  app: { get: (token: any) => any; use: (...args: any[]) => any },
  options: { baseUrl: string; mcpPath?: string },
): Promise<void> {
  const { mcpAuthRouter } = await import('@modelcontextprotocol/sdk/server/auth/router.js');
  const oauthService: CoreAiMcpOAuthService = app.get(CoreAiMcpOAuthService);
  const mcpPath = options.mcpPath ?? '/ai/mcp';

  const router = mcpAuthRouter({
    issuerUrl: new URL(options.baseUrl),
    provider: oauthService.buildOAuthProvider() as any,
    resourceServerUrl: new URL(`${options.baseUrl.replace(/\/$/, '')}${mcpPath}`),
  });

  app.use(router);
}
