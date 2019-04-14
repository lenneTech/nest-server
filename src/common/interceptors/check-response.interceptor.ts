import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { User } from '../../modules/user/user.model';
import { getRestricted } from '../decorators/restricted.decorator';
import { RoleEnum } from '../enums/roles.enum';
import { Context } from '../helper/context.class';

@Injectable()
export class CheckResponseInterceptor implements NestInterceptor {

  /**
   * Interception
   */
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {

    // Get current user
    const { currentUser } = Context.getData(context);
    console.log('Current user', currentUser);

    // Response interception
    return next
      .handle()
      .pipe(map((data) => {

        console.log('Data', data);

        // Prepare data for current user
        return this.checkData(data, currentUser);
      }));
  }

  /**
   * Check data for restricted properties (properties with `Restricted` decorator)
   *
   */
  checkData(data: any, user: User, processedObjects: any[] = []) {

    // Primitives
    if (!data || typeof data !== 'object') {
      return data;
    }

    // Prevent infinite recourse
    if (processedObjects.includes(data)) {
      return data;
    }
    processedObjects.push(data);


    // Array
    if (Array.isArray(data)) {

      // Check array items
      return data.map((item) => this.checkData(item, user, processedObjects));
    }

    // Object
    for (const propertyKey of Object.keys(data)) {

      // Get roles
      const roles = getRestricted(data, propertyKey);

      // If roles are specified
      if (roles && roles.some((value) => !!value)) {

        // Check user and user roles
        if (!user || !user.hasRole(roles)) {

          // Check special role for owner
          if (user && roles.includes(RoleEnum.OWNER)) {

            const userId = user.id.toString();

            if (!data.ownerIds || !(data.ownerIds === userId || (Array.isArray(data.ownerIds) && data.ownerIds.some(
              (item) => item.id ? item.id.toString() === userId : item.toString() === userId,
            )))) {

              // User is not the owner
              delete data[propertyKey];
            }
          } else {

            // The user does not have the required rights
            delete data[propertyKey];
          }
        }

      }

      // Check property data
      data[propertyKey] = this.checkData(data[propertyKey], user, processedObjects);
    }

    // Return processed data
    return data;
  }
}
