import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { checkRestricted } from '../decorators/restricted.decorator';
import { Context } from '../helpers/context.helper';

@Injectable()
export class CheckResponseInterceptor implements NestInterceptor {

  /**
   * Interception
   */
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {

    // Get current user
    const { currentUser } = Context.getData(context);

    // Response interception
    return next
      .handle()
      .pipe(map((data) => {

        // Prepare data for current user
        return checkRestricted(data, currentUser);
      }));
  }
}
