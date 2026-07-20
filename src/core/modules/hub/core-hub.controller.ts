import { Controller, Get, Headers, Optional, Param, Query, Res } from '@nestjs/common';
import { Response } from 'express';

import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';

import { CoreHubHtmlService } from './core-hub-html.service';
import { CoreHubService } from './core-hub.service';
import { HUB_PANELS } from './hub-nav';
import { CoreHubDbService } from './services/core-hub-db.service';
import { CoreHubEmailService } from './services/core-hub-email.service';
import { CoreHubMailboxService } from './services/core-hub-mailbox.service';
import { CoreHubMigrationsService } from './services/core-hub-migrations.service';
import { CoreHubSourcesService } from './services/core-hub-sources.service';
import { HubLogBufferService } from './services/hub-log-buffer.service';
import { HubQueryProfilerService } from './services/hub-query-profiler.service';
import { HubTraceBufferService } from './services/hub-trace-buffer.service';
import { buildHubSecurityHeaders, escapeHtml, generateNonce, injectNonce } from './helpers/hub-shell.helper';

/** Route sub-paths of every non-root panel — the shell handler answers all of them. */
const HUB_PAGE_PATHS = HUB_PANELS.filter((panel) => panel.path).map((panel) => panel.path);

/**
 * Serves the Hub SPA shell (all panel routes), the shared client runtime and the read-only JSON
 * sidecars. Mutating operations live in `CoreHubActionsController`.
 *
 * The controller path and required roles are assigned at runtime in `CoreHubModule.forRoot()` via
 * `Reflect.defineMetadata` (same pattern as the permissions module), so they follow the configured
 * `hub.path` / `hub.roles`.
 *
 * Every response uses `@Res()` and is written manually: this bypasses the four global response
 * interceptors (which would otherwise walk/mutate the payload — `CheckSecurityInterceptor` deletes
 * secret-named keys in place) and lets the Hub set its own strict CSP + no-store headers.
 *
 * Overridable via `overrides.hub.controller`.
 */
@Controller()
export class CoreHubController {
  private cachedClientScript?: string;

  constructor(
    protected readonly hubService: CoreHubService,
    protected readonly htmlService: CoreHubHtmlService,
    protected readonly dbService: CoreHubDbService,
    protected readonly migrationsService: CoreHubMigrationsService,
    protected readonly sourcesService: CoreHubSourcesService,
    protected readonly emailService: CoreHubEmailService,
    protected readonly logBuffer: HubLogBufferService,
    protected readonly traceBuffer: HubTraceBufferService,
    protected readonly queryProfiler: HubQueryProfilerService,
    // Only provided when the mailbox is enabled.
    @Optional() protected readonly mailboxService?: CoreHubMailboxService,
  ) {}

  @Get('ai.json')
  async aiJson(@Res() res: Response): Promise<void> {
    this.sendJson(res, await this.sourcesService.getAi());
  }

  @Get('auth-migration.json')
  async authMigrationJson(@Res() res: Response): Promise<void> {
    this.sendJson(res, await this.sourcesService.getAuthMigration());
  }

  @Get('config.json')
  configJson(@Res() res: Response): void {
    this.sendJson(res, this.hubService.getConfigMasked());
  }

  @Get('cron.json')
  cronJson(@Res() res: Response): void {
    this.sendJson(res, this.sourcesService.getCron());
  }

  @Get('emails.json')
  emailsJson(@Res() res: Response): void {
    if (!this.emailService.previewEnabled) {
      this.sendJson(res, { available: false, hint: 'The email preview panel is disabled (hub.emailPreview: false).' });
      return;
    }
    this.sendJson(res, this.emailService.getTemplates());
  }

  @Get('error-codes.json')
  errorCodesJson(@Query('locale') locale: string | undefined, @Res() res: Response): void {
    this.sendJson(res, this.sourcesService.getErrorCodes(locale || 'en'));
  }

  @Get('dashboard.json')
  dashboardJson(@Res() res: Response): void {
    this.sendJson(res, this.hubService.getDashboard());
  }

  @Get('db.json')
  async dbJson(@Res() res: Response): Promise<void> {
    this.sendJson(res, await this.dbService.getDbStats());
  }

  @Get('diagnostics.json')
  diagnosticsJson(@Res() res: Response): void {
    this.sendJson(res, this.hubService.getDiagnostics(this.collectorBuffers()));
  }

  @Get('files.json')
  async filesJson(
    @Query('bucket') bucket: string | undefined,
    @Query('skip') skip: string | undefined,
    @Query('limit') limit: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    this.sendJson(res, await this.dbService.getFiles(bucket || 'fs', Number(skip) || 0, Number(limit) || 100));
  }

  @Get('migrations.json')
  async migrationsJson(@Res() res: Response): Promise<void> {
    this.sendJson(res, await this.migrationsService.getStatus());
  }

  @Get('mailbox.json')
  mailboxJson(@Query('since') since: string | undefined, @Res() res: Response): void {
    if (!this.mailboxService) {
      this.sendJson(res, { available: false, hint: 'The mailbox is not enabled.' });
      return;
    }
    this.sendJson(res, this.mailboxService.getMailbox(since !== undefined ? Number(since) : undefined));
  }

  @Get('mailbox/:seq/html')
  mailboxHtml(@Param('seq') seq: string, @Res() res: Response): void {
    const html = this.mailboxService?.getMailHtml(Number(seq));
    res.set({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; img-src * data:; style-src 'unsafe-inline'; font-src data:",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
    });
    res
      .type('html')
      .send(
        html ??
          '<!DOCTYPE html><html><body style="font-family:sans-serif;color:#8b97a8;padding:20px">No preview available.</body></html>',
      );
  }

  @Get('logs.json')
  logsJson(@Query('since') since: string | undefined, @Res() res: Response): void {
    if (!this.logBuffer.enabled) {
      this.sendJson(res, { available: false, hint: 'The logs collector is disabled.' });
      return;
    }
    this.sendJson(res, this.logBuffer.getData(since !== undefined ? Number(since) : undefined));
  }

  @Get('models.json')
  modelsJson(@Res() res: Response): void {
    this.sendJson(res, this.dbService.getModels());
  }

  /**
   * ADMIN-gated auth probe AND cockpit-chrome payload: 200 returns the navigation, environment badge,
   * version and external links the client uses to build the layout; 401/403 keeps the shell showing
   * only the login form. The public shell HTML deliberately carries none of this data.
   */
  @Get('session.json')
  sessionJson(@Res() res: Response): void {
    this.sendJson(res, this.hubService.getSessionPayload());
  }

  @Get('queries.json')
  queriesJson(@Res() res: Response): void {
    if (!this.queryProfiler.enabled) {
      this.sendJson(res, {
        available: false,
        hint: 'The query profiler is disabled (opt-in via hub.collectors.queries).',
      });
      return;
    }
    this.sendJson(res, this.queryProfiler.getData());
  }

  @Get('traces.json')
  tracesJson(@Query('since') since: string | undefined, @Res() res: Response): void {
    if (!this.traceBuffer.enabled) {
      this.sendJson(res, { available: false, hint: 'The traces collector is disabled.' });
      return;
    }
    this.sendJson(res, this.traceBuffer.getData(since !== undefined ? Number(since) : undefined));
  }

  @Get('routes.json')
  async routesJson(@Res() res: Response): Promise<void> {
    this.sendJson(res, await this.sourcesService.getRoutes());
  }

  /**
   * Server-rendered email preview, delivered as sandboxed HTML for an <iframe>. A dedicated,
   * stricter CSP (no scripts) applies to the rendered template markup.
   */
  @Get('emails/preview')
  async emailPreview(
    @Query('template') template: string | undefined,
    @Query('locale') locale: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.emailService.renderPreview(template || '', locale);
    res.set({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; img-src * data:; style-src 'unsafe-inline'; font-src data:",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
    });
    if ('available' in result && result.available === false) {
      res
        .type('html')
        .send(
          `<!DOCTYPE html><html><body style="font-family:sans-serif;color:#8b97a8;padding:20px">${escapeHtml(result.hint)}</body></html>`,
        );
      return;
    }
    // The rendered template is trusted framework/project EJS output; the sandbox CSP blocks scripts.
    res.type('html').send((result as { html: string }).html);
  }

  // Public: the shared client runtime carries no secrets, and the public /hub/auth token-paste page
  // must be able to load it in cookie-less setups.
  @Get('hub.js')
  @Roles(RoleEnum.S_EVERYONE)
  hubJs(@Res() res: Response): void {
    if (!this.cachedClientScript) {
      this.cachedClientScript = this.htmlService.buildClientScript();
    }
    res.set(buildHubSecurityHeaders(generateNonce(), { cacheable: true }));
    res.type('application/javascript').send(this.cachedClientScript);
  }

  /**
   * Root panel (dashboard). PUBLIC — the shell is only the cockpit chrome (no data), and the client
   * shows a login form when the ADMIN-gated data sidecars answer 401. This makes the Hub
   * self-sufficient: an admin can log in directly at the API without the frontend. The panel
   * structure is already discoverable via the public `hub.js`, so serving the shell adds no exposure;
   * every `*.json` sidecar and every action stays ADMIN-gated.
   */
  @Get()
  @Roles(RoleEnum.S_EVERYONE)
  root(@Headers('authorization') authHeader: string | undefined, @Res() res: Response): void {
    this.sendShell(res, authHeader);
  }

  /** All other panel routes serve the same (public) shell; the client router picks the active panel. */
  @Get(HUB_PAGE_PATHS)
  @Roles(RoleEnum.S_EVERYONE)
  page(@Headers('authorization') authHeader: string | undefined, @Res() res: Response): void {
    this.sendShell(res, authHeader);
  }

  /** Backward-compatible alias for the login/token-paste entry (now handled inline by the shell). */
  @Get('auth')
  @Roles(RoleEnum.S_EVERYONE)
  authPage(@Res() res: Response): void {
    this.sendShell(res, undefined);
  }

  /** Buffer fill levels for the diagnostics panel. */
  protected collectorBuffers(): Record<string, { capacity: number; enabled: boolean; size: number }> {
    const logs = this.logBuffer.getData();
    const traces = this.traceBuffer.getData();
    const queries = this.queryProfiler.getData();
    return {
      logs: { capacity: 0, enabled: this.logBuffer.enabled, size: logs.records.length },
      queries: { capacity: 0, enabled: this.queryProfiler.enabled, size: queries.recent.length },
      traces: { capacity: 0, enabled: this.traceBuffer.enabled, size: traces.traces.length },
    };
  }

  protected sendJson(res: Response, data: unknown): void {
    res.set(buildHubSecurityHeaders(generateNonce()));
    res.type('application/json').send(JSON.stringify(data));
  }

  protected sendShell(res: Response, authHeader?: string): void {
    const nonce = generateNonce();
    const html = injectNonce(this.htmlService.buildShell(authHeader), nonce);
    res.set(buildHubSecurityHeaders(nonce));
    res.type('html').send(html);
  }
}
