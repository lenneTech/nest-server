import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

import { IRequestContext, RequestContext } from '../services/request-context.service';

/**
 * Middleware that wraps each request in a RequestContext (AsyncLocalStorage).
 * Uses a lazy getter for currentUser so that the user is resolved at access time,
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
    };
    RequestContext.run(context, () => next());
  }
}
