import 'reflect-metadata';
import { RoleEnum } from '../enums/role.enum';

/**
 * Restricted meta key
 */
const restrictedMetaKey = Symbol('restricted');

/**
 * Decorator for restricted properties
 *
 * If the decorator is used it will be checked if the current user has one of the included roles.
 * If this is not the case, the property is removed from the return object.
 *
 * Activation of the CheckResponseInterceptor is necessary for use.
 */
export const Restricted = (...roles: string[]): PropertyDecorator => {
  return Reflect.metadata(restrictedMetaKey, roles);
};

/**
 * Get restricted
 */
export const getRestricted = (object: unknown, propertyKey: string) => {
  return Reflect.getMetadata(restrictedMetaKey, object, propertyKey);
};

/**
 * Check data for restricted properties (properties with `Restricted` decorator)
 */
export const checkRestricted = (
  data: any,
  user: { id: any; hasRole: (roles: string[]) => boolean },
  processedObjects: any[] = []
) => {
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
    return data.map((item) => checkRestricted(item, user, processedObjects));
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

          if (
            !data.ownerIds ||
            !(
              data.ownerIds === userId ||
              (Array.isArray(data.ownerIds) &&
                data.ownerIds.some((item) => (item.id ? item.id.toString() === userId : item.toString() === userId)))
            )
          ) {
            // User is not the owner
            delete data[propertyKey];
            continue;
          }
        } else {
          // The user does not have the required rights
          delete data[propertyKey];
          continue;
        }
      }
    }

    // Check property data
    data[propertyKey] = checkRestricted(data[propertyKey], user, processedObjects);
  }

  // Return processed data
  return data;
};
