import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { RoleEnum } from '../../common/enums/role.enum.js';
import { getTenantContextResolver } from '../../common/services/core-tenant-context.registry.js';
import { ErrorCode } from '../error-code/error-codes.js';
import { SYNC_DEFAULTS } from './core-sync.constants.js';
import { CoreSyncService, SyncResyncRequiredException } from './core-sync.service.js';
import type { ISyncPullResult, ISyncPushResult } from './interfaces/core-sync.interfaces.js';

/**
 * The sync routes (protocol `docs/offline-sync-protocol.md` §4–§6): `GET /sync/{model}` pulls a page of changes,
 * `POST /sync/{model}` pushes changes. Both need a signed-in caller — a session cookie or a bearer token, exactly as on
 * every other route; the model's own operation roles decide the rest (`@PersistedModel({ sync: { roles } })`).
 *
 * API tokens are refused here like on every route without `@ApiTokenScopes()`. A project that wants them extends the
 * controller, re-declares the handlers with `@ApiTokenScopes('sync')` and passes it as `sync.controller` override.
 */
@ApiTags('sync')
@Controller(SYNC_DEFAULTS.path)
@Roles(RoleEnum.S_USER)
export class CoreSyncController {
  constructor(protected readonly syncService: CoreSyncService) {}

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

  /**
   * Without `X-Tenant-Id` a sync request spans every tenant the caller is an active member of (plan §3.4) — or every
   * tenant for an administrator under `adminBypass`. The tenant guard admits an `S_USER` route without resolving
   * those memberships, so this asks the guard's own membership logic (`core-tenant-context.registry.ts`). A header
   * the guard validated is kept; without multi-tenancy nothing happens.
   */
  protected async scopeTenants(req: any, currentUser: any): Promise<void> {
    if (!req || !currentUser?.id || req.tenantId || req.tenantIds || req.isAdminBypass) {
      return;
    }
    const resolved = await getTenantContextResolver()?.resolve(currentUser, undefined);
    if (resolved?.isAdminBypass) {
      req.isAdminBypass = true;
    } else if (resolved?.tenantIds) {
      req.tenantIds = resolved.tenantIds;
    }
  }

  /** 429 with `Retry-After` once the caller exceeded the limit of this kind */
  protected async limit(kind: 'pull' | 'push', currentUser: any, res: any): Promise<void> {
    const retryAfter = await this.syncService.rateLimit(kind, currentUser);
    if (retryAfter !== undefined) {
      res?.setHeader?.('Retry-After', String(retryAfter));
      throw new HttpException(ErrorCode.RATE_LIMIT_EXCEEDED, HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}
