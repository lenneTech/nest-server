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
        return checkRestricted(data, currentUser, this.config);
      }),
    );
  }
}
