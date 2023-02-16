import { ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { Request as RequestType } from 'express';

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
    return { currentUser: null, args: null, request: null };
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
