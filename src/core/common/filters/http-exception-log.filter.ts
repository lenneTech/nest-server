import { ArgumentsHost, Catch, ContextType, ExceptionFilter, HttpException } from '@nestjs/common';
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
    const type = host.getType() as ContextType | 'graphql';
    if (type === 'graphql') {
      return exception;
    }

    // REST
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const status = exception.getStatus();
    res.status(status).json({
      ...exception,
    });
  }
}
