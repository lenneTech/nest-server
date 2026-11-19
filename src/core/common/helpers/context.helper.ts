import { ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { Request as RequestType } from 'express';

import { isAgentCallContext, resolveAgentCallRequest } from './execution-context-request.helper.js';

/**
 * Helper for context processing
 * @deprecated use functions directly
 */
export default class Context {
  /**
   * Get data from Context
   * @deprecated use getContextData function
   */
  public static getData(context: ExecutionContext): {
    args: any;
    currentUser: { [key: string]: any };
    request: RequestType;
  } {
    return getContextData(context);
  }
}

/**
 * Get data from Context
 */
export function getContextData(context: ExecutionContext): {
  args: any;
  currentUser: { [key: string]: any };
  request: RequestType;
} {
  // Check context
  if (!context) {
    return { args: null, currentUser: null, request: null };
  }

  // An agent function / MCP call (nestjs-ai plan §1): the user is the one of the request the call runs in — never a
  // `user` in the call's arguments, which the model or the MCP client wrote. A request-less call has no user, so the
  // interceptors filter its result for an anonymous caller (the strictest view).
  if (isAgentCallContext(context)) {
    const agentRequest = resolveAgentCallRequest(context);
    return {
      args: context.getArgByIndex(0),
      currentUser: agentRequest?.user,
      request: (agentRequest ?? null) as RequestType,
    };
  }

  // Init data
  let user: { [key: string]: any };
  let rawContext: any = null;
  let ctx: any = null;
  let request: any;
  try {
    rawContext = GqlExecutionContext.create(context);
    ctx = rawContext?.getContext();
    request = ctx.req;
  } catch (e) {
    // console.info(e);
  }

  let args: any;
  if (rawContext) {
    try {
      args = rawContext.getArgs();
    } catch (e) {
      // console.info(e);
    }
  }

  // Get data
  if (ctx) {
    // User from GraphQL context
    user = ctx?.user || ctx?.req?.user;
  } else {
    request = context?.switchToHttp ? context.switchToHttp()?.getRequest() : null;
    if (request) {
      args = request.body;

      // User from REST context
      user = request.user;
    }
  }

  // Return data
  return { args, currentUser: user, request };
}
