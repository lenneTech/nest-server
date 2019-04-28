import { ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { IUser } from '../../modules/user/interfaces/user.interface';

/**
 * Helper for context processing
 */
export class Context {

  /**
   * Get data from Context
   */
  public static getData(context: ExecutionContext): { currentUser: IUser, args: any } {

    // Check context
    if (!context) {
      return { currentUser: null, args: null };
    }

    // Init data
    let user: IUser;
    const ctx: any = GqlExecutionContext.create(context).getContext();
    let args: any = GqlExecutionContext.create(context).getArgs();

    // Get data
    if (ctx) {

      // User from GraphQL context
      user = ctx.user;
    } else {
      const request = context.switchToHttp().getRequest();
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
