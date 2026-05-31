import { Controller, Delete, Get, Logger, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Request, Response } from 'express';

import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { ConfigService } from '../../common/services/config.service';
import { CoreBetterAuthModule } from '../better-auth/core-better-auth.module';
import { CoreAiMcpOAuthService } from './services/core-ai-mcp-oauth.service';
import { CoreAiMcpService } from './services/core-ai-mcp.service';

/**
 * MCP Streamable-HTTP endpoint at `/ai/mcp`.
 *
 * Exposes the AI tool registry to external MCP clients. The request must carry a
 * valid Bearer token (or session); the handler resolves the user via
 * {@link CoreAiMcpController.resolveUser} (which reuses `req.user` and falls back to
 * verifying the Bearer token directly, since `@Roles(S_EVERYONE)` does not populate
 * `req.user`). The MCP session is bound to that user and only their permitted tools
 * are exposed/executed.
 *
 * `@Roles(S_EVERYONE)` lets the request reach the handler (the guard would
 * otherwise reject), and the handler performs the MCP-specific 401 with a
 * `WWW-Authenticate` header as the protocol expects.
 *
 * When `ai.mcp.oauth` is enabled, the handler additionally accepts OAuth 2.1 access
 * tokens (see `mountAiMcpOAuth`); otherwise it authenticates via Bearer/session token.
 */
@ApiExcludeController()
@Controller('ai/mcp')
@Roles(RoleEnum.S_EVERYONE)
export class CoreAiMcpController {
  protected readonly logger = new Logger(CoreAiMcpController.name);

  /** Active transports keyed by MCP session id. */
  private readonly transports = new Map<string, { lastUsed: number; transport: any }>();

  /** Cap on concurrent MCP sessions (oldest evicted on overflow). */
  private readonly maxSessions = 500;

  constructor(
    private readonly mcpService: CoreAiMcpService,
    private readonly oauthService: CoreAiMcpOAuthService,
  ) {}

  @Post()
  async handlePost(@Req() req: Request, @Res() res: Response): Promise<void> {
    const user = await this.resolveUser(req);
    if (!user?.id) {
      this.unauthorized(req, res);
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let entry = sessionId ? this.transports.get(sessionId) : undefined;

    if (!entry) {
      let StreamableHTTPServerTransport: any;
      try {
        ({ StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js'));
      } catch (err) {
        // The MCP SDK is a peer-style optional dependency — it must be installed
        // by the consumer project when `ai.mcp.enabled` is true. Surface a
        // 503 with an actionable hint instead of the raw "Cannot find module"
        // 500 that bubbles from the lazy `import()`.
        return this.mcpUnavailable(res, err as Error);
      }
      const { randomUUID } = await import('node:crypto');
      const transport: any = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      const server = await this.mcpService.createServer(user);
      await server.connect(transport);
      // The MCP SDK transport exposes `onclose` as a callback property (not a DOM
      // EventTarget), so addEventListener does not apply here.
      // eslint-disable-next-line unicorn/prefer-add-event-listener
      transport.onclose = () => {
        if (transport.sessionId) {
          this.transports.delete(transport.sessionId);
        }
      };
      entry = { lastUsed: Date.now(), transport };
    }

    entry.lastUsed = Date.now();
    await entry.transport.handleRequest(req, res, req.body);

    // The sessionId is assigned during handleRequest (initialize); register after.
    if (entry.transport.sessionId && !this.transports.has(entry.transport.sessionId)) {
      this.evictIfNeeded();
      this.transports.set(entry.transport.sessionId, entry);
    }
  }

  @Get()
  async handleGet(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.handleSessionRequest(req, res);
  }

  @Delete()
  async handleDelete(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.handleSessionRequest(req, res);
  }

  /**
   * Resolve the authenticated user for an MCP request. Uses `req.user` (set by the
   * BetterAuth middleware for valid tokens) and falls back to verifying the Bearer
   * token directly via the BetterAuth token service — so MCP works regardless of
   * whether the `S_EVERYONE` guard populated the user.
   */
  protected async resolveUser(req: Request): Promise<any | null> {
    const fromRequest = (req as any).user;
    if (fromRequest?.id) {
      return fromRequest;
    }

    const bearer = (req.headers?.authorization || '').replace(/^bearer\s+/i, '').trim();

    // BetterAuth/legacy token (the default auth).
    const tokenService = CoreBetterAuthModule.getTokenServiceInstance();
    if (tokenService) {
      try {
        const { token } = tokenService.extractTokenFromRequest(req);
        const user = token ? await tokenService.verifyAndLoadUser(token) : null;
        if (user?.id) {
          return user;
        }
      } catch {
        // fall through to OAuth
      }
    }

    // OAuth 2.1 access token (when ai.mcp.oauth is enabled).
    if (bearer && this.oauthEnabled()) {
      const payload = this.oauthService.verifyAccessToken(bearer);
      if (payload?.sub) {
        return this.oauthService.loadUser(payload.sub);
      }
    }

    return null;
  }

  /**
   * Whether the OAuth 2.1 layer is enabled via `ai.mcp.oauth`.
   */
  protected oauthEnabled(): boolean {
    const mcp = ConfigService.get<{ oauth?: boolean }>('ai.mcp');
    return typeof mcp === 'object' && mcp?.oauth === true;
  }

  /**
   * Forward a GET (SSE stream) or DELETE (close) to the session's transport.
   */
  private async handleSessionRequest(req: Request, res: Response): Promise<void> {
    const user = await this.resolveUser(req);
    if (!user?.id) {
      this.unauthorized(req, res);
      return;
    }
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const entry = sessionId ? this.transports.get(sessionId) : undefined;
    if (!entry) {
      res.status(404).json({ error: 'Unknown or expired MCP session' });
      return;
    }
    entry.lastUsed = Date.now();
    await entry.transport.handleRequest(req, res, (req as any).body);
  }

  /**
   * 503 Service Unavailable when the optional `@modelcontextprotocol/sdk` peer
   * dependency is not installed. The SDK is lazy-imported because not every
   * consumer needs MCP — when `ai.mcp.enabled` is set but the SDK is missing,
   * we surface the actionable install hint rather than the raw require-stack
   * trace from the failed `import()`.
   */
  private mcpUnavailable(res: Response, err: Error): void {
    this.logger.error(`MCP SDK not available: ${err.message}`);
    res.status(503).json({
      error:
        'MCP server unavailable: the @modelcontextprotocol/sdk peer dependency is not installed. ' +
        'Run `pnpm add @modelcontextprotocol/sdk` (or `npm i @modelcontextprotocol/sdk`) ' +
        'in your project and restart the server.',
      statusCode: 503,
    });
  }

  /**
   * MCP-style 401 with a `WWW-Authenticate` header for OAuth discovery.
   */
  private unauthorized(req: Request, res: Response): void {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res
      .status(401)
      .set({ 'WWW-Authenticate': `Bearer resource_metadata="${baseUrl}/ai/mcp"` })
      .json({ error: 'Unauthorized: a valid Bearer token is required' });
  }

  /**
   * Evict the oldest session when the cap is exceeded (bounded memory).
   */
  private evictIfNeeded(): void {
    if (this.transports.size < this.maxSessions) {
      return;
    }
    let oldestKey: string | undefined;
    let oldest = Infinity;
    for (const [key, value] of this.transports) {
      if (value.lastUsed < oldest) {
        oldest = value.lastUsed;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      const evicted = this.transports.get(oldestKey);
      this.transports.delete(oldestKey);
      try {
        evicted?.transport.close?.();
      } catch {
        // ignore close errors during eviction
      }
    }
  }
}
