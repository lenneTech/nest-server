import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

import { ConfigService } from '../services/config.service';
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
        const config = ConfigService.configFastButReadOnly?.multiTenancy;
        if (!config || config.enabled === false) return undefined;
        const field = config.userField ?? 'tenantId';
        return (req as any).user?.[field] ?? undefined;
      },
    };
    RequestContext.run(context, () => next());
  }
}
