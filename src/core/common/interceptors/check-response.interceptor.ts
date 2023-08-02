import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { checkRestricted } from '../decorators/restricted.decorator';
import { getContextData } from '../helpers/context.helper';

/**
 * Interceptor to check the response data for current user
 */
@Injectable()
export class CheckResponseInterceptor implements NestInterceptor {
  /**
   * Interception
   */
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    // Get current user
    const { currentUser }: any = getContextData(context);

    // Response interception
    return next.handle().pipe(
      map((data) => {
        // Prepare response data for current user
        return checkRestricted(data, currentUser, { throwError: false });
      }),
    );
  }
}
