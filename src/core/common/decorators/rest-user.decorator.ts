import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import { isAgentCallContext, resolveAgentCallRequest } from '../helpers/execution-context-request.helper.js';

/**
 * User decorator for REST request
 */
export const RESTUser = createParamDecorator((data: unknown, ctx: ExecutionContext) => {
  // An agent function / MCP call: the request's user, never one in the call's arguments (nestjs-ai plan §1)
  if (isAgentCallContext(ctx)) {
    return resolveAgentCallRequest(ctx)?.user;
  }
  const request = ctx.switchToHttp().getRequest();
  return request.user;
});
