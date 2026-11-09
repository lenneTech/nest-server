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
    // The exception's own fields, minus what it carries for the log: `options` and the `cause` passed to it (an
    // internal error, a query, a connection string) must never reach the client. The shape the frontends read
    // (response, status, message, name) is unchanged.
    const body: Record<string, unknown> = { ...exception };
    delete body.options;
    delete body.cause;
    res.status(status).json(exception instanceof ServiceUnavailableException ? body.response : body);
  }
}
