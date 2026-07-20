import { Injectable, Logger, Optional } from '@nestjs/common';

import { EmailService } from '../../../common/services/email.service';
import { RequestContext } from '../../../common/services/request-context.service';
import { HubActionMessage } from '../hub-action-messages';
import { CoreHubDbService } from './core-hub-db.service';
import { CoreHubEmailService } from './core-hub-email.service';
import { CoreHubMailboxService } from './core-hub-mailbox.service';
import { CoreHubMigrationsService } from './core-hub-migrations.service';
import { CoreHubSourcesService } from './core-hub-sources.service';
import { HubLogBufferService } from './hub-log-buffer.service';
import { HubQueryProfilerService } from './hub-query-profiler.service';
import { HubTraceBufferService } from './hub-trace-buffer.service';

/** Illustrative sample data for the test-mail action. */
const TEST_MAIL_DATA = {
  appName: 'Nest Server',
  firstName: 'Hub',
  link: 'https://example.com/verify?token=SAMPLE',
  name: 'Hub Admin',
  url: 'https://example.com/verify?token=SAMPLE',
};

/**
 * Executes the Hub's mutating actions, each behind an audit log line recording the acting admin.
 *
 * Read/mutate separation: this service holds all state-changing operations, so a project can override
 * it (`overrides.hub.actionsService`) to veto or extend actions in one place.
 */
@Injectable()
export class CoreHubActionsService {
  protected readonly logger = new Logger('HubAction');

  constructor(
    protected readonly migrationsService: CoreHubMigrationsService,
    protected readonly dbService: CoreHubDbService,
    protected readonly sourcesService: CoreHubSourcesService,
    protected readonly hubEmailService: CoreHubEmailService,
    protected readonly logBuffer: HubLogBufferService,
    protected readonly traceBuffer: HubTraceBufferService,
    protected readonly queryProfiler: HubQueryProfilerService,
    @Optional() protected readonly emailService?: EmailService,
    @Optional() protected readonly mailboxService?: CoreHubMailboxService,
  ) {}

  /** Clear a collector's ring buffer. */
  clearBuffer(name: 'logs' | 'mailbox' | 'queries' | 'traces'): { cleared: string } {
    this.audit(`clear ${name} buffer`);
    switch (name) {
      case 'logs':
        this.logBuffer.clear();
        break;
      case 'mailbox':
        this.mailboxService?.clear();
        break;
      case 'queries':
        this.queryProfiler.clear();
        break;
      case 'traces':
        this.traceBuffer.clear();
        break;
    }
    return { cleared: name };
  }

  /** Fire/stop/start a cron job. */
  controlCron(name: string, action: 'start' | 'stop' | 'trigger'): { action: string; name: string } {
    this.audit(`cron ${action} ${name}`);
    this.sourcesService.controlCron(name, action);
    return { action, name };
  }

  /** Delete a GridFS file (the confirm keyword must equal its filename). */
  async deleteFile(id: string, expectedFilename: string): Promise<{ deleted: { filename: string; id: string } }> {
    this.audit(`delete file ${id}`);
    return { deleted: await this.dbService.deleteFile(id, expectedFilename) };
  }

  /** Roll back the last migration. */
  async rollbackMigration(): Promise<{ rolledBack?: string }> {
    this.audit('rollback last migration');
    return this.migrationsService.rollbackLast();
  }

  /** Run all pending migrations. */
  async runMigrations(): Promise<{ ran: string[] }> {
    this.audit('run pending migrations');
    return this.migrationsService.runPending();
  }

  /** Send a test mail (lands in the mailbox when capture mode is active). */
  async sendTestEmail(to: string, template?: string, locale?: string): Promise<{ sent: boolean; to: string }> {
    if (!this.emailService) {
      throw new Error(HubActionMessage.emailServiceUnavailable);
    }
    const htmlTemplate = this.resolveTestTemplate(template, locale);
    this.audit(`send test mail to ${to}`);
    await this.emailService.sendMail(to, 'Hub test email', {
      htmlTemplate,
      templateData: { ...TEST_MAIL_DATA, email: to },
    });
    return { sent: true, to };
  }

  /**
   * Resolve the template file name for a test mail, validated against the live template inventory.
   *
   * Security: a caller-supplied `template`/`locale` is only accepted when it maps to a real entry in
   * `CoreHubEmailService.getTemplates()`. This mirrors `renderPreview`'s allowlist so the test-mail
   * action can never point the renderer at a path outside the templates directory (`..` traversal).
   */
  protected resolveTestTemplate(template?: string, locale?: string): string {
    const inventory = this.hubEmailService.getTemplates().templates;
    // Preserve the historical defaults ('welcome', or 'email-verification' when a locale is given),
    // but bound every path to the inventory.
    const requestedBase = template || (locale ? 'email-verification' : 'welcome');
    const match = inventory.find((entry) => entry.name === requestedBase);
    if (!match) {
      throw new Error(HubActionMessage.unknownEmailTemplate(requestedBase));
    }
    // Append the locale suffix only when it is a known variant of this template.
    if (locale && match.locales.includes(locale)) {
      return `${requestedBase}-${locale}`;
    }
    return requestedBase;
  }

  /** Write an audit line with the acting admin's id (from the async request context). */
  protected audit(action: string): void {
    const userId = RequestContext.getCurrentUser()?.id ?? 'unknown';
    this.logger.warn(`[HUB-ACTION] ${action} by user ${userId}`);
  }
}
