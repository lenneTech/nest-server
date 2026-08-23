import { Controller, Delete, Get, Logger, OnModuleDestroy, Optional, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { hostname } from 'node:os';

import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { ConfigService } from '../../common/services/config.service';
import { CoreRedisService } from '../../common/services/core-redis.service';
import { CoreBetterAuthModule } from '../better-auth/core-better-auth.module';
import { ErrorCode } from '../error-code/error-codes';
import { CoreAiMcpOAuthService } from './services/core-ai-mcp-oauth.service';
import { CoreAiMcpService } from './services/core-ai-mcp.service';

/**
 * MCP Streamable-HTTP endpoint at `/ai/mcp`.
 *
 * Exposes the AI tool registry to external MCP clients. The request must carry a
 * valid Bearer token (or session); the handler resolves the user via
 * {@link CoreAiMcpController.resolveUser} (which reuses `req.user` and falls back to
 * verifying the Bearer token directly). Since 11.36.5 `@Roles(S_EVERYONE)` DOES populate
 * `req.user` — the guard identifies without denying — so the fallback is now a second line
 * of defence rather than the only path. One consequence worth knowing: in a legacy-JWT
 * deployment this endpoint previously answered 401 for everyone, because `req.user` was
 * unset and no other resolution path applied; it now authenticates any holder of a valid
 * legacy access token. That is not an elevation — the server is still built per user with
 * the registry's role filter and the per-owner session binding — but it is a surface that
 * was effectively unreachable before. The MCP session is bound to that user and only their
 * permitted tools are exposed/executed.
 *
 * `@Roles(S_EVERYONE)` lets the request reach the handler (the guard would
 * otherwise reject), and the handler performs the MCP-specific 401 with a
 * `WWW-Authenticate` header as the protocol expects.
 *
 * When `ai.mcp.oauth` is enabled, the handler additionally accepts OAuth 2.1 access
 * tokens (see `mountAiMcpOAuth`); otherwise it authenticates via Bearer/session token.
 *
 * ## Multi-replica
 *
 * A Streamable-HTTP transport is a live object holding the open response stream — it cannot
 * be serialized, so the session map is inherently process-local and `/ai/mcp` REQUIRES sticky
 * sessions behind a load balancer. When Redis is configured, session ids are additionally
 * registered in a shared registry (replica + owning user), which turns a mis-routed request
 * into an explicit 409 naming the owning replica instead of a misleading "unknown session" 404.
 * Without Redis the behavior is unchanged.
 *
 * The registry entry records the OWNING USER, and only that user is ever told about the 409.
 * Otherwise the cross-replica path would undo the local one: an authenticated caller probing
 * ids would learn both that a session id is valid and the internal hostname/PID holding it,
 * where the same probe against the local map deliberately answers 404.
 */
@ApiExcludeController()
@Controller('ai/mcp')
@Roles(RoleEnum.S_EVERYONE)
export class CoreAiMcpController implements OnModuleDestroy {
  protected readonly logger = new Logger(CoreAiMcpController.name);

  /**
   * Active transports keyed by MCP session id.
   *
   * `ownerId` is load-bearing, not bookkeeping. The transport is built once via
   * `createServer(user)` and stays bound to THAT user's identity and role-filtered tools for its
   * whole life, while the lookup below is driven by a client-supplied `mcp-session-id` header.
   * Authenticating the caller only proves they are *some* user, so without comparing the owner,
   * anyone holding another user's session id drives that user's server — the id travels in a
   * response header, through proxies and client logs.
   */
  private readonly transports = new Map<string, { lastUsed: number; ownerId: string; transport: any }>();

  /**
   * Cap on concurrent MCP sessions held by ONE user.
   *
   * The per-user cap is the load-bearing one. A single global cap alone made one authenticated
   * user able to evict everybody else's sessions — each eviction closing a live SSE stream —
   * simply by opening sessions in a loop, because the victim was always the globally oldest.
   */
  private readonly maxSessionsPerUser = 25;

  /** Cap on concurrent MCP sessions across all users (bounded memory). */
  private readonly maxSessions = 500;

  /** Owner id written into the shared registry — identifies THIS replica. */
  protected readonly instanceId = `${hostname()}:${process.pid}`;

  /**
   * TTL of a shared registry entry. The local map is bounded by `maxSessions`, not by time,
   * so this TTL exists only to let a crashed replica's entries expire from Redis. It is
   * refreshed on every request of a session.
   */
  protected readonly sessionTtlSeconds = 3600;

  constructor(
    private readonly mcpService: CoreAiMcpService,
    private readonly oauthService: CoreAiMcpOAuthService,
    @Optional() protected readonly redisService?: CoreRedisService,
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

    // A session belongs to the user it was created for. Treat someone else's id as unknown
    // rather than as an authorization error — confirming it exists would turn the endpoint into
    // an oracle for valid session ids.
    if (entry && entry.ownerId !== user.id) {
      entry = undefined;
      res.status(404).json({ error: 'Unknown or expired MCP session' });
      return;
    }

    if (!entry && sessionId) {
      const owner = await this.foreignSessionOwner(sessionId, user.id);
      if (owner) {
        this.foreignSession(res, owner);
        return;
      }
    }

    if (!entry) {
      let StreamableHTTPServerTransport: any;
      try {
        ({ StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js'));
      } catch (err) {
        // Imported lazily so a consumer that never enables MCP does not pay for
        // loading the SDK at startup. It IS a regular dependency of this package and
        // reaches BOTH consumption modes — npm-mode transitively, CLI-vendored
        // projects through the dependency merge — so a failure here is a resolution
        // problem, not an absent package. Surface a 503 instead of the raw
        // "Cannot find module" 500 that bubbles from the lazy `import()`.
        // See mcpUnavailable() below for the full reasoning.
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
          this.releaseSession(transport.sessionId);
        }
      };
      entry = { lastUsed: Date.now(), ownerId: user.id, transport };
    }

    entry.lastUsed = Date.now();
    await entry.transport.handleRequest(req, res, req.body);

    // The sessionId is assigned during handleRequest (initialize); register after.
    if (entry.transport.sessionId) {
      if (!this.transports.has(entry.transport.sessionId)) {
        this.evictIfNeeded(user.id);
        this.transports.set(entry.transport.sessionId, entry);
      }
      // Also refreshes the TTL for an already-registered session.
      this.registerSession(entry.transport.sessionId, user.id);
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
    const held = sessionId ? this.transports.get(sessionId) : undefined;
    // Same ownership rule as the POST path: another user's session is not ours to serve.
    const entry = held && held.ownerId === user.id ? held : undefined;
    if (!entry) {
      const owner = sessionId ? await this.foreignSessionOwner(sessionId, user.id) : undefined;
      if (owner) {
        this.foreignSession(res, owner);
        return;
      }
      res.status(404).json({ error: 'Unknown or expired MCP session' });
      return;
    }
    entry.lastUsed = Date.now();
    this.registerSession(sessionId as string, user.id);
    await entry.transport.handleRequest(req, res, (req as any).body);
  }

  /**
   * Replica holding a session that this process does not hold — but ONLY when the session belongs
   * to `userId`. Undefined when Redis is disabled, the session is unknown, it belongs to this
   * instance, or it belongs to somebody else.
   *
   * The owner comparison is what keeps this path in step with the local one. Answering 409 for any
   * session id an authenticated caller can name would confirm the id exists AND disclose the
   * internal `<hostname>:<pid>` holding it — an oracle the local map deliberately refuses by
   * returning 404. Only the session's own user benefits from the 409 anyway: it tells THEIR client
   * to retry against the right replica.
   *
   * Never throws: a registry outage must degrade to the plain "unknown session" path, not to a 500.
   */
  protected async foreignSessionOwner(sessionId: string, userId: string): Promise<string | undefined> {
    if (!this.redisService?.enabled) {
      return undefined;
    }
    try {
      const raw = await this.redisService.getClient().get(this.sessionKey(sessionId));
      const entry = this.parseSessionEntry(raw);
      if (!entry || entry.userId !== userId || entry.instanceId === this.instanceId) {
        return undefined;
      }
      return entry.instanceId;
    } catch (err) {
      this.logger.debug(`MCP session registry lookup failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * Parse a shared registry value, or undefined when it is absent or not readable.
   *
   * An entry written by an older version carries the bare instance id and no owner. It is treated
   * as unreadable on purpose: without an owner we cannot tell whether the caller may learn about
   * it, and "fall through to 404" is the safe answer during a rolling upgrade.
   */
  protected parseSessionEntry(raw: null | string): undefined | { instanceId: string; userId: string } {
    if (!raw) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw);
      return parsed?.instanceId && parsed?.userId ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /** Register the session (or refresh its TTL) in the shared registry. Fire-and-forget. */
  protected registerSession(sessionId: string, userId: string): void {
    if (!this.redisService?.enabled) {
      return;
    }
    this.redisService
      .getClient()
      .set(
        this.sessionKey(sessionId),
        JSON.stringify({ instanceId: this.instanceId, userId }),
        'EX',
        this.sessionTtlSeconds,
      )
      .catch((err: Error) => this.logger.debug(`MCP session registry write failed: ${err.message}`));
  }

  /** Drop the session from the shared registry (close/evict). Fire-and-forget. */
  protected releaseSession(sessionId: string): Promise<void> {
    if (!this.redisService?.enabled) {
      return Promise.resolve();
    }
    return this.redisService
      .getClient()
      .del(this.sessionKey(sessionId))
      .then(() => undefined)
      .catch((err: Error) => this.logger.debug(`MCP session registry delete failed: ${err.message}`));
  }

  /**
   * Close every live transport and drop this instance's sessions from the shared registry.
   *
   * Each transport holds an OPEN response stream, and an open stream keeps the HTTP server from
   * closing — so without this, `app.close()` waits on clients that will never disconnect on their
   * own. Releasing the registry keys matters too: a restarted replica's sessions would otherwise
   * keep answering 409 "owned by another replica" — naming a replica that no longer exists —
   * until their TTL expires an hour later.
   */
  async onModuleDestroy(): Promise<void> {
    const sessions = [...this.transports.keys()];
    for (const [, entry] of this.transports) {
      try {
        await entry.transport?.close?.();
      } catch (error) {
        this.logger.debug(`MCP transport close failed: ${error instanceof Error ? error.message : 'unknown'}`);
      }
    }
    this.transports.clear();
    await Promise.allSettled(sessions.map((sessionId) => this.releaseSession(sessionId)));
  }

  protected sessionKey(sessionId: string): string {
    return this.redisService!.key('ai-mcp-session', sessionId);
  }

  /**
   * 409 Conflict when the session exists — on another replica. The live transport cannot be
   * moved, so the only fix is routing: name the owner and state the sticky-session requirement
   * instead of returning a 404 that reads like "your session expired".
   */
  protected foreignSession(res: Response, owner: string): void {
    res.status(409).json({
      error:
        `MCP session belongs to another server instance (${owner}); this instance is ${this.instanceId}. ` +
        'The MCP transport is held in process memory and cannot be shared, so /ai/mcp requires sticky ' +
        'sessions — route every request of one MCP session to the same replica.',
      statusCode: 409,
    });
  }

  /**
   * 503 Service Unavailable when `@modelcontextprotocol/sdk` cannot be loaded.
   * The SDK is lazy-imported because not every consumer needs MCP — when
   * `ai.mcp.enabled` is set but the import fails, we surface an actionable hint
   * rather than the raw require-stack trace from the failed `import()`.
   *
   * The SDK is a regular `dependency` of this package and reaches BOTH consumption
   * modes: npm-mode consumers resolve it transitively, and CLI-vendored projects get
   * it merged into their own `package.json` (`convertCloneToVendored()` copies every
   * upstream dependency, and the import-closure scan additionally backfills bare
   * specifiers found in dynamic `import()` calls). A failure here is therefore
   * almost always a RESOLUTION problem — a bundler or test runner with its own
   * module resolution can fail on the subpath export while plain Node succeeds — not
   * a genuinely absent package.
   *
   * The underlying error goes to the log only, never into the response: it carries
   * filesystem paths.
   */
  private mcpUnavailable(res: Response, err: Error): void {
    this.logger.error(`MCP SDK not available: ${err.message}`);
    res.status(503).json({
      error:
        `${ErrorCode.SERVICE_UNAVAILABLE} — MCP server unavailable: ` +
        '@modelcontextprotocol/sdk could not be loaded. It ships as a dependency of ' +
        '@lenne.tech/nest-server, so this usually means the module could not be resolved ' +
        'rather than that it is missing; see the server log for the underlying error.',
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
   * Make room for a new session of `ownerId`, evicting WITHIN the offending user's own set.
   *
   * Eviction is not free — it closes a live SSE stream — so who pays for it matters. The naive
   * "drop the globally oldest" rule let one authenticated user open sessions in a loop and
   * disconnect every other user in turn. Here a user first evicts their own oldest session at
   * their personal cap, and when the global cap is reached the victim is the oldest session of
   * whoever holds the MOST sessions, i.e. the account actually responsible for the pressure.
   */
  private evictIfNeeded(ownerId: string): void {
    const perUser = new Map<string, string[]>();
    for (const [key, value] of this.transports) {
      const owned = perUser.get(value.ownerId);
      if (owned) {
        owned.push(key);
      } else {
        perUser.set(value.ownerId, [key]);
      }
    }

    if ((perUser.get(ownerId)?.length ?? 0) >= this.maxSessionsPerUser) {
      this.evictOldestOf(perUser.get(ownerId));
      return;
    }

    if (this.transports.size < this.maxSessions) {
      return;
    }

    let largest: string[] | undefined;
    for (const owned of perUser.values()) {
      if (!largest || owned.length > largest.length) {
        largest = owned;
      }
    }
    this.evictOldestOf(largest);
  }

  /**
   * Close and forget the least recently used session among the given ids
   */
  private evictOldestOf(sessionIds: string[] | undefined): void {
    let oldestKey: string | undefined;
    let oldest = Infinity;
    for (const key of sessionIds ?? []) {
      const value = this.transports.get(key);
      if (value && value.lastUsed < oldest) {
        oldest = value.lastUsed;
        oldestKey = key;
      }
    }
    if (!oldestKey) {
      return;
    }
    const evicted = this.transports.get(oldestKey);
    this.transports.delete(oldestKey);
    this.releaseSession(oldestKey);
    try {
      evicted?.transport.close?.();
    } catch {
      // ignore close errors during eviction
    }
  }
}
