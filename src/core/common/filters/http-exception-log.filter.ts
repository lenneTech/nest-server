import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { GqlContextType } from '@nestjs/graphql';
import { Response } from 'express';

/**
 * Nest's logger rather than `console.debug` (12.0.0): the stack carries the filter as its context, honours the
 * application's log levels and JSON mode, and stays out of test output where those levels are narrowed. Module
 * level, not a class member, so a project subclass that declares its own `logger` keeps compiling.
 */
const exceptionLogger = new Logger('HttpExceptionLogFilter');

@Catch(HttpException)
export class HttpExceptionLogFilter implements ExceptionFilter {
  /**
   * Log exception
   */
  catch(exception: HttpException, host: ArgumentsHost) {
    // Log
    exceptionLogger.debug(exception.stack);

    // GraphQL
    const type = host.getType<GqlContextType>();
    if (type === 'graphql') {
      return exception;
    }

    // REST
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const status = exception.getStatus();
    res
      .status(status)
      .json(exception instanceof ServiceUnavailableException ? ({ ...exception } as any).response : { ...exception });
  }
}
