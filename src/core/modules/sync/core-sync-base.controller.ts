import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

import { getTenantContextResolver } from '../../common/services/core-tenant-context.registry.js';
import { ErrorCode } from '../error-code/error-codes.js';
import { CoreSyncService } from './core-sync.service.js';

/**
 * What the sync routes share: the tenant scope of a header-less request and the per-user rate limit. Declares no route,
 * so `CoreSyncController` (pull, push) and `CoreSyncHintsController` (hints) each register only their own.
 *
 * `@Injectable()` only so the constructor's parameter types are emitted: the two controllers inherit it.
 */
@Injectable()
export abstract class CoreSyncBaseController {
  constructor(protected readonly syncService: CoreSyncService) {}

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
