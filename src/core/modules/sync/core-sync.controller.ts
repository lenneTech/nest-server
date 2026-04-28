import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';

import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { CoreSyncService } from './core-sync.service';
import { ISyncPullResponse, ISyncPushResponse } from './sync.interfaces';
import { SyncRateLimit, SyncRateLimitGuard } from './sync-rate-limit.guard';

/**
 * REST controller for offline sync.
 *
 * Routes:
 *   GET  /sync/:model    Delta pull (cursor-paginated, includes tombstones)
 *   POST /sync/:model    Bulk push with optimistic concurrency
 *
 * Auth defaults to `@Roles(RoleEnum.S_USER)`. Override via project subclass
 * to add extra checks (e.g. additional headers, custom roles).
 *
 * Rate limiting is configured via `ISyncConfig.rateLimit` and applied via
 * `@SyncRateLimit` decorator + `SyncRateLimitGuard`. Defaults: 60 pulls
 * and 30 pushes per minute per user.
 *
 * Security guarantees:
 * - All writes go through `CoreSyncService` → model's `CrudService` →
 *   `process()` pipeline. `@Restricted` (input + output), `@Roles`,
 *   tenant plugin, role-guard plugin, audit plugin all stay authoritative.
 * - DTO validation per item (via SyncRegistry-registered create/update DTOs)
 *   acts as additional defense-in-depth on top of MapAndValidatePipe.
 * - Hard delete is never permitted via this controller (forced false in
 *   the service layer).
 * - `_includeDeleted` is never accepted as a query parameter.
 */
@Controller('sync')
@UseGuards(SyncRateLimitGuard)
export class CoreSyncController {
  constructor(protected readonly syncService: CoreSyncService) {}

  /**
   * GET /sync/:model?cursor=<base64>&limit=<n>
   *
   * Returns the next window of changes for the requested model that the
   * caller is permitted to see (after tenant scoping + restricted-field
   * filtering by the response interceptors).
   */
  @Get(':model')
  @Roles(RoleEnum.S_USER)
  @SyncRateLimit({ max: 60, windowSeconds: 60 })
  async pull(
    @Param('model') model: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<ISyncPullResponse> {
    const decoded = this.syncService.decodeCursor(cursor);
    const lim = limit ? Math.max(1, parseInt(limit, 10) || 0) : undefined;
    return this.syncService.pull(model, decoded, { limit: lim });
  }

  /**
   * POST /sync/:model
   * Body: { items: ISyncPushItem[] }
   *
   * Each item is independently validated, deduplicated via idempotency
   * cache, dispatched to create/update/delete with optimistic concurrency,
   * and reported back with a per-item status. Status 200 OK is returned
   * even when individual items fail — the per-item statuses convey the
   * actual outcomes.
   */
  @Post(':model')
  @Roles(RoleEnum.S_USER)
  @SyncRateLimit({ max: 30, windowSeconds: 60 })
  async push(
    @Param('model') model: string,
    @Body() body: { items: any[] },
  ): Promise<ISyncPushResponse> {
    return this.syncService.push(model, body?.items || [], {});
  }
}
