import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

import { IRequestContext, RequestContext } from '../services/request-context.service';

/**
 * Middleware that wraps each request in a RequestContext (AsyncLocalStorage).
 * Uses lazy getters for currentUser and tenantId so that they are resolved at access time,
 * not at middleware execution time. This ensures that auth middleware that runs
 * after this middleware still sets req.user before it's read.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    const context: IRequestContext = {
      get currentUser() {
        return (req as any).user || undefined;
      },
      get language() {
        return req.headers?.['accept-language'] || undefined;
      },
      get tenantId() {
        // Only return tenant ID set by CoreTenantGuard (after membership validation).
        // The raw header is NEVER used for plugin filtering.
        return (req as any).tenantId ?? undefined;
      },
      get tenantIds() {
        return (req as any).tenantIds ?? undefined;
      },
      get tenantRole() {
        return (req as any).tenantRole ?? undefined;
      },
      get isAdminBypass() {
        return (req as any).isAdminBypass ?? false;
      },
    };
    RequestContext.run(context, () => next());
  }
}
