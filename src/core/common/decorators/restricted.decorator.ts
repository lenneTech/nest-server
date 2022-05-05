import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { RoleEnum } from '../enums/role.enum';
import { getStringIds } from '../helpers/db.helper';
import { IdsType } from '../types/ids.type';

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
 *
 * If restricted roles includes RoleEnum.OWNER, ownerId(s) from current data (in DB) must be set in options.
 */
export const checkRestricted = (
  data: any,
  user: { id: any; hasRole: (roles: string[]) => boolean },
  options: { ignoreUndefined?: boolean; ownerIds?: IdsType; throwError?: boolean } = {},
  processedObjects: any[] = []
) => {
  const config = {
    ignoreUndefined: true,
    throwError: true,
    ...options,
  };

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
    return data.map((item) => checkRestricted(item, user, config, processedObjects));
  }

  // Object
  for (const propertyKey of Object.keys(data)) {
    // Check undefined
    if (data[propertyKey] === undefined && config.ignoreUndefined) {
      continue;
    }

    // Get roles
    const roles = getRestricted(data, propertyKey);

    // If roles are specified
    if (roles && roles.some((value) => !!value)) {
      // Check user and user roles
      if (!user || !user.hasRole(roles)) {
        // Check special role for owner
        if (user && roles.includes(RoleEnum.OWNER)) {
          const userId = getStringIds(user);
          const ownerIds = config.ownerIds ? getStringIds(config.ownerIds) : null;

          if (
            // No owner IDs
            !ownerIds ||
            // User is not the owner
            !(ownerIds === userId || (Array.isArray(ownerIds) && ownerIds.includes(userId)))
          ) {
            // The user does not have the required rights and is not the owner
            if (config.throwError) {
              if (!config.ownerIds) {
                throw new UnauthorizedException('Lack of ownerIds to verify ownership of ' + propertyKey);
              }
              throw new UnauthorizedException('Current user is not allowed to set ' + propertyKey);
            }
            continue;
          }
        } else {
          // The user does not have the required rights
          if (config.throwError) {
            throw new UnauthorizedException('Current user is not allowed to set ' + propertyKey);
          }
          continue;
        }
      }
    }

    // Check property data
    data[propertyKey] = checkRestricted(data[propertyKey], user, config, processedObjects);
  }

  // Return processed data
  return data;
};
