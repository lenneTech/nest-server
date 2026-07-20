import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Headers,
  Param,
  Post,
} from '@nestjs/common';

import { HubActionMessage } from './hub-action-messages';
import { CoreHubActionsService } from './services/core-hub-actions.service';

/** Body shape shared by the confirm-guarded actions. */
interface ConfirmBody {
  confirm?: string;
}

/**
 * The Hub's mutating actions (migrations, file delete, cron control, buffer clears, test mail).
 *
 * Registered as a SEPARATE controller only when `hub.actions !== false`, so disabling actions simply
 * removes the routes (404). Path + roles metadata are assigned at runtime in `CoreHubModule.forRoot()`
 * exactly like the read controller.
 *
 * Every mutating request must carry the `X-Hub-Request: 1` header (CSRF defense in depth: a custom
 * header makes the request non-simple, so a cross-origin attempt triggers a CORS preflight the
 * framework will not approve). Destructive actions additionally require a server-validated `confirm`
 * keyword that the UI makes the operator type.
 *
 * Overridable via `overrides.hub.actionsController`.
 */
@Controller()
export class CoreHubActionsController {
  constructor(protected readonly actions: CoreHubActionsService) {}

  @Post('actions/collectors/:name/clear')
  async clearCollector(
    @Param('name') name: string,
    @Body() body: ConfirmBody,
    @Headers('x-hub-request') hubHeader: string | undefined,
  ): Promise<unknown> {
    this.requireHubRequest(hubHeader);
    this.requireConfirm(body, 'CLEAR');
    if (!['logs', 'mailbox', 'queries', 'traces'].includes(name)) {
      throw new BadRequestException(HubActionMessage.unknownCollector);
    }
    return this.wrap(() =>
      Promise.resolve(this.actions.clearBuffer(name as 'logs' | 'mailbox' | 'queries' | 'traces')),
    );
  }

  @Post('actions/cron/:name/:action')
  async cron(
    @Param('name') name: string,
    @Param('action') action: string,
    @Body() body: ConfirmBody,
    @Headers('x-hub-request') hubHeader: string | undefined,
  ): Promise<unknown> {
    this.requireHubRequest(hubHeader);
    if (!['start', 'stop', 'trigger'].includes(action)) {
      throw new BadRequestException(HubActionMessage.unknownCronAction);
    }
    this.requireConfirm(body, name);
    return this.wrap(() => Promise.resolve(this.actions.controlCron(name, action as 'start' | 'stop' | 'trigger')));
  }

  @Delete('actions/files/:id')
  async deleteFile(
    @Param('id') id: string,
    @Body() body: ConfirmBody,
    @Headers('x-hub-request') hubHeader: string | undefined,
  ): Promise<unknown> {
    this.requireHubRequest(hubHeader);
    if (!body?.confirm) {
      throw new BadRequestException(HubActionMessage.confirmationFilenameRequired);
    }
    return this.wrap(() => this.actions.deleteFile(id, body.confirm as string));
  }

  @Post('actions/email/test')
  async emailTest(
    @Body() body: { locale?: string; template?: string; to?: string },
    @Headers('x-hub-request') hubHeader: string | undefined,
  ): Promise<unknown> {
    this.requireHubRequest(hubHeader);
    if (!body?.to) {
      throw new BadRequestException(HubActionMessage.recipientRequired);
    }
    return this.wrap(() => this.actions.sendTestEmail(body.to as string, body.template, body.locale));
  }

  @Post('actions/migrations/down')
  async migrationsDown(
    @Body() body: ConfirmBody,
    @Headers('x-hub-request') hubHeader: string | undefined,
  ): Promise<unknown> {
    this.requireHubRequest(hubHeader);
    this.requireConfirm(body, 'DOWN');
    return this.wrap(() => this.actions.rollbackMigration());
  }

  @Post('actions/migrations/run')
  async migrationsRun(
    @Body() body: ConfirmBody,
    @Headers('x-hub-request') hubHeader: string | undefined,
  ): Promise<unknown> {
    this.requireHubRequest(hubHeader);
    this.requireConfirm(body, 'RUN');
    return this.wrap(() => this.actions.runMigrations());
  }

  /** Validate the server-side confirmation keyword. */
  protected requireConfirm(body: ConfirmBody, expected: string): void {
    if (body?.confirm !== expected) {
      throw new BadRequestException(HubActionMessage.confirmationKeywordMismatch(expected));
    }
  }

  /** CSRF defense: mutating requests must carry the X-Hub-Request header. */
  protected requireHubRequest(header: string | undefined): void {
    if (!header) {
      throw new ForbiddenException(HubActionMessage.missingHubRequestHeader);
    }
  }

  /** Run an action, mapping domain errors to 400 (admin-facing plain message). */
  protected async wrap(fn: () => Promise<unknown>): Promise<unknown> {
    try {
      const result = await fn();
      return { ok: true, timestamp: new Date().toISOString(), ...(result as object) };
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : HubActionMessage.actionFailed);
    }
  }
}
