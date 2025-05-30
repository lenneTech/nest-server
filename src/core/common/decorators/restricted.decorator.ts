import { UnauthorizedException } from '@nestjs/common';
import 'reflect-metadata';
import _ = require('lodash');

import { ProcessType } from '../enums/process-type.enum';
import { RoleEnum } from '../enums/role.enum';
import { equalIds, getIncludedIds } from '../helpers/db.helper';
import { RequireAtLeastOne } from '../types/required-at-least-one.type';

/**
 * Restricted meta key
 */
const restrictedMetaKey = Symbol('restricted');

/**
 * Restricted type
 */
export type RestrictedType = (
  | RequireAtLeastOne<
      { memberOf?: string | string[]; processType?: ProcessType; roles?: string | string[] },
      'memberOf' | 'roles'
    >
  | string
  | string[]
)[];

/**
 * Decorator for restricted properties
 *
 * The restricted decorator can include roles as strings or object with property `roles`
 * and memberships as objects with property `memberOf`.
 *
 * Roles:
 *    If one or more Role(Enum)s are set, the user must have at least one of it in his `role` property.
 *
 * Memberships:
 *    If one or more membership objects are set, the ID of the user must be included in one of the
 *    properties of the processed item, which is specified by the value of `memberOf`
 *    Via processType the restriction can be set for input or output only
 */
export const Restricted = (...rolesOrMember: RestrictedType): ClassDecorator & PropertyDecorator => {
  return Reflect.metadata(restrictedMetaKey, rolesOrMember);
};

/**
 * Get restricted data for (property of) object
 */
export const getRestricted = (object: unknown, propertyKey?: string): RestrictedType => {
  if (!object) {
    return null;
  }
  if (!propertyKey) {
    return Reflect.getMetadata(restrictedMetaKey, object);
  }
  return Reflect.getMetadata(restrictedMetaKey, object, propertyKey);
};

/**
 * Check data for restricted properties (properties with `Restricted` decorator)
 * For special Roles and member of group checking the dbObject must be set in options
 */
export const checkRestricted = (
  data: any,
  user: { hasRole: (roles: string[]) => boolean; id: any },
  options: {
    allowCreatorOfParent?: boolean;
    checkObjectItself?: boolean;
    dbObject?: any;
    debug?: boolean;
    ignoreFunctions?: boolean;
    ignoreUndefined?: boolean;
    isCreatorOfParent?: boolean;
    mergeRoles?: boolean;
    noteCheckedObjects?: boolean;
    processType?: ProcessType;
    removeUndefinedFromResultArray?: boolean;
    throwError?: boolean;
  } = {},
  processedObjects: any[] = [],
) => {
  // Act like Roles handling: checkObjectItself = false & mergeRoles = true
  // For Input: throwError = true
  // For Output: throwError = false
  const config = {
    allowCreatorOfParent: true,
    checkObjectItself: false,
    ignoreFunctions: true,
    ignoreUndefined: true,
    isCreatorOfParent: false,
    mergeRoles: true,
    noteCheckedObjects: true,
    removeUndefinedFromResultArray: true,
    throwError: true,
    ...options,
  };

  // Primitives
  if (!data || typeof data !== 'object' || (config.noteCheckedObjects && data._objectAlreadyCheckedForRestrictions)) {
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
    let result = data.map(item => checkRestricted(item, user, config, processedObjects));
    if (!config.throwError && config.removeUndefinedFromResultArray) {
      result = result.filter(item => item !== undefined);
    }
    return result;
  }

  // Check function
  const validateRestricted = (restricted) => {
    if (config.noteCheckedObjects && data?._objectAlreadyCheckedForRestrictions) {
      return true;
    }

    // Check restrictions
    if (!restricted?.length) {
      return true;
    }

    let valid = false;

    // Get roles restricted element
    const roles: string[] = [];
    restricted.forEach((item) => {
      if (typeof item === 'string') {
        roles.push(item);
      } else if (
        item?.roles?.length
        && (config.processType && item.processType ? config.processType === item.processType : true)
      ) {
        if (Array.isArray(item.roles)) {
          roles.push(...item.roles);
        } else {
          roles.push(item.roles);
        }
      } else if (Array.isArray(item)) {
        roles.push(...item);
      }
    });

    // Check roles
    if (roles.length) {
      // Prevent access for everyone, including administrators
      if (roles.includes(RoleEnum.S_NO_ONE)) {
        return false;
      }

      // Check access rights
      if (
        roles.includes(RoleEnum.S_EVERYONE)
        || user?.hasRole?.(roles)
        || (user?.id && roles.includes(RoleEnum.S_USER))
        || (roles.includes(RoleEnum.S_SELF) && equalIds(data, user))
        || (roles.includes(RoleEnum.S_CREATOR)
          && (('createdBy' in data && equalIds(data.createdBy, user))
            || (config.allowCreatorOfParent && !('createdBy' in data) && config.isCreatorOfParent)))
      ) {
        valid = true;
      }
    }

    if (!valid) {
      // Get groups
      const groups = restricted.filter((item) => {
        return (
          typeof item === 'object'
          // Check if object is valid
          && item.memberOf?.length
          // Check if processType is specified and is valid for current process
          && (config.processType && item.processType ? config.processType === item.processType : true)
        );
      }) as { memberOf: string | string[] }[];

      // Check groups
      if (groups.length) {
        // Get members from groups
        const members = [];
        for (const group of groups) {
          let properties: string[] = group.memberOf as string[];
          if (!Array.isArray(group.memberOf)) {
            properties = [group.memberOf];
          }
          for (const property of properties) {
            const items = config.dbObject?.[property];
            if (items) {
              if (Array.isArray(items)) {
                members.concat(items);
              } else {
                members.push(items);
              }
            }
          }
        }

        // Check if user is a member
        if (getIncludedIds(members, user)) {
          valid = true;
        }
      }

      // Check if there are no limitations
      if (!roles.length && !groups.length) {
        valid = true;
      }
    }

    return valid;
  };

  // Check data object
  const objectRestrictions = getRestricted(data.constructor) || [];
  if (config.checkObjectItself) {
    const objectIsValid = validateRestricted(objectRestrictions);
    if (!objectIsValid) {
      if (config.debug) {
        console.debug(`The current user has no access rights for ${data.constructor?.name}`);
      }
      // Throw error
      if (config.throwError) {
        throw new UnauthorizedException(`The current user has no access rights for ${data.constructor?.name}`);
      }
      return null;
    }
  }

  // Check properties of object
  for (const propertyKey of Object.keys(data)) {
    // Ignore functions
    if (typeof data[propertyKey] === 'function' && config.ignoreFunctions) {
      continue;
    }

    // Check undefined
    if (data[propertyKey] === undefined && config.ignoreUndefined) {
      continue;
    }

    // Check restricted
    const restricted = getRestricted(data, propertyKey) || [];
    const concatenatedRestrictions = config.mergeRoles ? _.uniq(objectRestrictions.concat(restricted)) : restricted;
    const valid = validateRestricted(concatenatedRestrictions);

    // Check rights
    if (valid) {
      // Check if data is user or user is creator of data (for nested plain objects)
      config.isCreatorOfParent
        = equalIds(data, user) || ('createdBy' in data ? equalIds(data.createdBy, user) : config.isCreatorOfParent);

      // Check deep
      data[propertyKey] = checkRestricted(data[propertyKey], user, config, processedObjects);
    } else {
      if (config.debug) {
        console.debug(
          `The current user has no access rights for ${propertyKey}${data.constructor?.name ? ` of ${data.constructor.name}` : ''}`,
        );
      }
      // Throw error
      if (config.throwError) {
        throw new UnauthorizedException(
          `The current user has no access rights for ${propertyKey}${data.constructor?.name ? ` of ${data.constructor.name}` : ''}`,
        );
      }

      // Remove property
      delete data[propertyKey];
    }
  }

  // Return processed data
  return data;
};
