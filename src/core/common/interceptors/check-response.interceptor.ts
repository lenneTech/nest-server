import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { checkRestricted } from '../decorators/restricted.decorator';
import { getContextData } from '../helpers/context.helper';
import { ConfigService } from '../services/config.service';

/**
 * Interceptor to check the response data for current user
 */
@Injectable()
export class CheckResponseInterceptor implements NestInterceptor {
  config = {
    checkObjectItself: false,
    debug: false,
    ignoreUndefined: true,
    mergeRoles: true,
    noteCheckedObjects: true,
    removeUndefinedFromResultArray: true,
    throwError: false,
  };

  constructor(private readonly configService: ConfigService) {
    const configuration = this.configService.getFastButReadOnly('security.checkResponseInterceptor');
    if (typeof configuration === 'object') {
      this.config = { ...this.config, ...configuration };
    }
  }

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
        const start = Date.now();
        const result = checkRestricted(data, currentUser, this.config);
        if (
          this.config.debug
          && Date.now() - start >= (typeof this.config.debug === 'number' ? this.config.debug : 100)
        ) {
          console.warn(
            `Duration for CheckResponseInterceptor is too long: ${Date.now() - start}ms`,
            Array.isArray(data) ? `${data[0].constructor.name}[]: ${data.length}` : data?.constructor?.name,
          );
        }
        return result;
      }),
    );
  }
}
