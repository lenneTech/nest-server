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
import { isAgentCallContext } from '../helpers/execution-context-request.helper.js';

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

    // An agent function call (`@nestjs/ai`, `'ai'`) or an MCP call (`@nestjs/mcp`, `'mcp'`): the second argument is
    // the CALL, not a response (nestjs-ai plan §1). Returning nothing hands the exception back to the package, which
    // tells the model or MCP client its message. Writing to `switchToHttp()` there threw a TypeError instead, and the
    // model read "Internal server error" for every 401 / 403 / 404. Every other transport is unchanged.
    if (isAgentCallContext(host)) {
      return undefined;
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
