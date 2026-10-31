import { Controller, Get, NotFoundException, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { RoleEnum } from '../../common/enums/role.enum.js';
import { ErrorCode } from '../error-code/error-codes.js';
import { CoreSyncBaseController } from './core-sync-base.controller.js';
import { SYNC_DEFAULTS } from './core-sync.constants.js';

/**
 * `GET /sync/hints` (protocol §9): server-sent change hints. A controller of its own, registered before
 * `CoreSyncController`: Nest registers a class's own routes before the ones it inherits, so a project controller that
 * re-declares `pull()` (`@Get(':model')`) would otherwise read `hints` as a model name and answer 404 — and an
 * EventSource does not reconnect after an error status, so the hints would stop without a sign.
 *
 * A signed-in caller always gets the stream (200); models the caller may not pull never send a hint, so the stream
 * reveals nothing about which models exist. API tokens are refused here like on every route without
 * `@ApiTokenScopes()`; a project that wants them extends this controller, re-declares `hints()` with
 * `@ApiTokenScopes('sync')` and passes it as `sync.hintsController` override.
 */
@ApiTags('sync')
@Controller(SYNC_DEFAULTS.path)
@Roles(RoleEnum.S_USER)
export class CoreSyncHintsController extends CoreSyncBaseController {
  /** The stream is `CoreSyncService.openHintStream()`; 404 while the SSE channel is switched off */
  @ApiBearerAuth()
  @ApiOperation({
    description:
      'Server-sent events: `event: change` with `{ model, at }` whenever a model the caller may pull changes; ' +
      '`models` (comma-separated) narrows the stream',
    summary: 'Change hints (SSE)',
  })
  @Get('hints')
  @Roles(RoleEnum.S_USER)
  async hints(
    @Query('models') models: string,
    @CurrentUser() currentUser: any,
    @Req() req: any,
    @Res() res: any,
  ): Promise<void> {
    if (!this.syncService.hintsEnabled('sse')) {
      throw new NotFoundException(ErrorCode.SYNC_MODEL_NOT_FOUND);
    }
    // Counted like a pull: an EventSource reconnects on its own, and every reconnect is a request
    await this.limit('pull', currentUser, res);
    // Without X-Tenant-Id the stream spans every membership of the caller, as a pull does
    await this.scopeTenants(req, currentUser);
    const named = typeof models === 'string' ? models.split(',').map((model) => model.trim()) : [];
    await this.syncService.openHintStream(req, res, currentUser, named.filter(Boolean));
  }
}
