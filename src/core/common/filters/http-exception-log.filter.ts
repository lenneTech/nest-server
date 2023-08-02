import { ArgumentsHost, Catch, ExceptionFilter, HttpException, ServiceUnavailableException } from '@nestjs/common';
import { GqlContextType } from '@nestjs/graphql';
import { Response } from 'express';

@Catch(HttpException)
export class HttpExceptionLogFilter implements ExceptionFilter {
  /**
   * Log exception
   */
  catch(exception: HttpException, host: ArgumentsHost) {
    // Log
    console.debug(exception.stack);

    // GraphQL
    const type = host.getType<GqlContextType>();
    if (type === 'graphql') {
      return exception;
    }

    // REST
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const status = exception.getStatus();
    res.status(status).json(
      exception instanceof ServiceUnavailableException ? ({ ...exception } as any).response : { ...exception },
    );
  }
}
