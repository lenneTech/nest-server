import { ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';

/**
 * Helper for context processing
 */
export class Context {
  /**
   * Get data from Context
   */
  public static getData(context: ExecutionContext): { currentUser: { [key: string]: any }; args: any } {
    // Check context
    if (!context) {
      return { currentUser: null, args: null };
    }

    // Init data
    let user: { [key: string]: any };
    let ctx: any = null;
    try {
      ctx = GqlExecutionContext.create(context)?.getContext();
    } catch (e) {
      // console.log(e);
    }

    let args: any;
    try {
      args = GqlExecutionContext.create(context)?.getArgs();
    } catch (e) {
      // console.log(e);
    }

    // Get data
    if (ctx) {
      // User from GraphQL context
      user = ctx?.user || ctx?.req?.user;
    } else {
      const request = context?.switchToHttp ? context.switchToHttp()?.getRequest() : null;
      if (request) {
        args = request.body;

        // User from REST context
        user = request.user;
      }
    }

    // Return data
    return { currentUser: user, args };
  }
}
