import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { AuthResolver } from '../../../server/modules/auth/auth.resolver';
import { getContextData } from '../helpers/context.helper';
import { processDeep } from '../helpers/input.helper';

/**
 * Verification of all outgoing data via securityCheck
 */
@Injectable()
export class CheckSecurityInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    // Get current user
    const user = getContextData(context)?.currentUser;

    // Set force mode for sign in and sign up
    let force = false;
    if (!user) {
      if (context.getClass() === AuthResolver) {
        force = true;
      }
    }

    // Check response
    return next.handle().pipe(
      map((data) => {
        // Check data
        if (data && typeof data === 'object' && typeof data.securityCheck === 'function') {
          return data.securityCheck(user, force);
        }

        // Check if data is writeable (e.g. objects from direct access to json files via http are not writable)
        if (data && typeof data === 'object') {
          const writeable = !Object.keys(data).find((key) => !Object.getOwnPropertyDescriptor(data, key).writable);
          if (!writeable) {
            return data;
          }
        }

        // Check deep
        return processDeep(data, (item) => {
          if (!item || typeof item !== 'object' || typeof item.securityCheck !== 'function') {
            return item;
          }
          return item.securityCheck(user, force);
        });
      })
    );
  }
}
