import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { RoleEnum } from '../../common/enums/role.enum.js';
import { CoreSyncBaseController } from './core-sync-base.controller.js';
import { SYNC_DEFAULTS } from './core-sync.constants.js';
import { SyncResyncRequiredException } from './core-sync.service.js';
import type { ISyncPullResult, ISyncPushResult } from './interfaces/core-sync.interfaces.js';

/**
 * The sync routes (protocol `docs/offline-sync-protocol.md` §4–§6): `GET /sync/{model}` pulls a page of changes,
 * `POST /sync/{model}` pushes changes. Both need a signed-in caller — a session cookie or a bearer token, exactly as on
 * every other route; the model's own operation roles decide the rest (`@PersistedModel({ sync: { roles } })`). The
 * change hints (`GET /sync/hints`) are `CoreSyncHintsController`'s, registered before this one.
 *
 * API tokens are refused here like on every route without `@ApiTokenScopes()`. A project that wants them extends the
 * controller, re-declares the handlers with `@ApiTokenScopes('sync')` and passes it as `sync.controller` override.
 */
@ApiTags('sync')
@Controller(SYNC_DEFAULTS.path)
@Roles(RoleEnum.S_USER)
export class CoreSyncController extends CoreSyncBaseController {
  @ApiBearerAuth()
  @ApiOperation({ description: 'One page of changes after the cursor (protocol §5)', summary: 'Pull changes' })
  @Get(':model')
  @Roles(RoleEnum.S_USER)
  async pull(
    @Param('model') model: string,
    @Query('cursor') cursor: string,
    @Query('limit') limit: string,
    @CurrentUser() currentUser: any,
    @Req() req: any,
    @Res({ passthrough: true }) res: any,
  ): Promise<ISyncPullResult | object> {
    await this.limit('pull', currentUser, res);
    await this.scopeTenants(req, currentUser);
    try {
      return await this.syncService.pull(model, { cursor, limit }, currentUser);
    } catch (error) {
      if (error instanceof SyncResyncRequiredException) {
        // The protocol's body (protocol §8), not the shape of whatever exception filter the project registered
        res?.status?.(error.getStatus());
        return error.getResponse() as object;
      }
      throw error;
    }
  }

  @ApiBearerAuth()
  @ApiOperation({ description: 'Apply pushed changes item by item (protocol §6)', summary: 'Push changes' })
  @HttpCode(HttpStatus.OK)
  @Post(':model')
  @Roles(RoleEnum.S_USER)
  async push(
    @Param('model') model: string,
    @Body() body: any,
    @CurrentUser() currentUser: any,
    @Req() req: any,
    @Res({ passthrough: true }) res: any,
  ): Promise<{ results: ISyncPushResult[] }> {
    this.syncService.assertPushRequest(req);
    await this.limit('push', currentUser, res);
    await this.scopeTenants(req, currentUser);
    return this.syncService.push(model, body, currentUser);
  }
}
