import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { getContextData } from '../helpers/context.helper';
import { getStringIds } from '../helpers/db.helper';
import { processDeep } from '../helpers/input.helper';

/**
 * Verification of all outgoing data via securityCheck
 */
@Injectable()
export class CheckSecurityInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    // Get current user
    const user = getContextData(context)?.currentUser || null;

    // Set force mode for sign in and sign up
    let force = false;
    if (!user) {
      // Here the name is used and not the class itself, because the concrete class is located in the respective project.
      // In case of an override it is better to use the concrete class directly (context.getClass() instead of context.getClasss()?.name).
      if (context.getClass()?.name === 'AuthResolver') {
        force = true;
      }
    }

    // Check response
    return next.handle().pipe(
      map((data) => {
        // Check data
        if (data && typeof data === 'object' && typeof data.securityCheck === 'function') {
          const dataJson = JSON.stringify(data);
          const response = data.securityCheck(user, force);
          new Promise(() => {
            if (dataJson !== JSON.stringify(response)) {
              const id = getStringIds(data);
              console.debug('CheckSecurityInterceptor: securityCheck changed data of type', data.constructor.name, id && !Array.isArray(id) ? `with ID: ${id}` : '');
            }
          });
          return response;
        }

        // Check if data is writeable (e.g. objects from direct access to json files via http are not writable)
        if (data && typeof data === 'object') {
          const writeable = !Object.keys(data).find(key => !Object.getOwnPropertyDescriptor(data, key).writable);
          if (!writeable) {
            return data;
          }
        }

        // Check deep
        return processDeep(
          data,
          (item) => {
            if (!item || typeof item !== 'object' || typeof item.securityCheck !== 'function') {
              if (Array.isArray(item)) {
                return item.filter(i => i !== undefined);
              }
              return item;
            }
            const itemJson = JSON.stringify(item);
            const response = item.securityCheck(user, force);
            new Promise(() => {
              if (itemJson !== JSON.stringify(response)) {
                const id = getStringIds(item);
                console.debug('CheckSecurityInterceptor: securityCheck changed item of type', item.constructor.name, id && !Array.isArray(id) ? `with ID: ${id}` : '');
              }
            });
            return response;
          },
          { specialFunctions: ['securityCheck'] },
        );
      }),
    );
  }
}
