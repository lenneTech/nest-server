import { Controller, Delete, Get, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Request, Response } from 'express';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { CoreAiMcpService } from './services/core-ai-mcp.service';

/**
 * MCP Streamable-HTTP endpoint at `/ai/mcp`.
 *
 * Exposes the AI tool registry to external MCP clients. Authentication reuses the
 * framework's existing token resolution: the request must carry a valid Bearer
 * token (or session) so `@CurrentUser()` resolves a user — the MCP session is
 * bound to that user and only their permitted tools are exposed/executed.
 *
 * `@Roles(S_EVERYONE)` lets the request reach the handler (the guard would
 * otherwise reject), and the handler performs the MCP-specific 401 with a
 * `WWW-Authenticate` header as the protocol expects.
 *
 * Note: this first version authenticates via Bearer/session token. Full OAuth 2.1
 * dynamic client registration (per the framework `mcp-integration` guide) is a
 * later hardening step.
 */
@ApiExcludeController()
@Controller('ai/mcp')
@Roles(RoleEnum.S_EVERYONE)
export class CoreAiMcpController {
  /** Active transports keyed by MCP session id. */
  private readonly transports = new Map<string, { lastUsed: number; transport: any }>();

  /** Cap on concurrent MCP sessions (oldest evicted on overflow). */
  private readonly maxSessions = 500;

  constructor(private readonly mcpService: CoreAiMcpService) {}

  @Post()
  async handlePost(@CurrentUser() user: any, @Req() req: Request, @Res() res: Response): Promise<void> {
    if (!user?.id) {
      this.unauthorized(req, res);
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let entry = sessionId ? this.transports.get(sessionId) : undefined;

    if (!entry) {
      const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
      const { randomUUID } = await import('node:crypto');
      const transport: any = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      const server = await this.mcpService.createServer(user);
      await server.connect(transport);
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
  async handleGet(@CurrentUser() user: any, @Req() req: Request, @Res() res: Response): Promise<void> {
    await this.handleSessionRequest(user, req, res);
  }

  @Delete()
  async handleDelete(@CurrentUser() user: any, @Req() req: Request, @Res() res: Response): Promise<void> {
    await this.handleSessionRequest(user, req, res);
  }

  /**
   * Forward a GET (SSE stream) or DELETE (close) to the session's transport.
   */
  private async handleSessionRequest(user: any, req: Request, res: Response): Promise<void> {
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
