import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { ProcessType } from '../enums/process-type.enum';
import { RoleEnum } from '../enums/role.enum';
import { getIncludedIds } from '../helpers/db.helper';
import { RequireAtLeastOne } from '../types/required-at-least-one.type';
import * as _ from 'lodash';

/**
 * Restricted meta key
 */
const restrictedMetaKey = Symbol('restricted');

/**
 * Restricted type
 */
export type RestrictedType = (
  | string
  | RequireAtLeastOne<
      { memberOf?: string | string[]; roles?: string | string[]; processType?: ProcessType },
      'memberOf' | 'roles'
    >
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
  user: { id: any; hasRole: (roles: string[]) => boolean },
  options: {
    checkObjectItself?: boolean;
    dbObject?: any;
    ignoreUndefined?: boolean;
    processType?: ProcessType;
    removeUndefinedFromResultArray?: boolean;
    throwError?: boolean;
  } = {},
  processedObjects: any[] = []
) => {
  const config = {
    checkObjectItself: false,
    ignoreUndefined: true,
    removeUndefinedFromResultArray: true,
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
    let result = data.map((item) => checkRestricted(item, user, config, processedObjects));
    if (!config.throwError && config.removeUndefinedFromResultArray) {
      result = result.filter((item) => item !== undefined);
    }
    return result;
  }

  // Check function
  const validateRestricted = (restricted) => {
    // Check restrictions
    if (!restricted?.length) {
      return true;
    }

    let valid = false;

    // Get roles
    const roles: string[] = [];
    restricted.forEach((item) => {
      if (typeof item === 'string') {
        roles.push(item);
      } else if (
        item?.roles?.length &&
        (config.processType && item.processType ? config.processType === item.processType : true)
      ) {
        if (Array.isArray(item.roles)) {
          roles.push(...item.roles);
        } else {
          roles.push(item.roles);
        }
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
        roles.includes(RoleEnum.S_EVERYONE) ||
        user?.hasRole?.(roles) ||
        (user?.id && roles.includes(RoleEnum.S_USER)) ||
        (roles.includes(RoleEnum.S_SELF) && getIncludedIds(config.dbObject, user)) ||
        (roles.includes(RoleEnum.S_CREATOR) && getIncludedIds(config.dbObject?.createdBy, user))
      ) {
        valid = true;
      }
    }

    if (!valid) {
      // Get groups
      const groups = restricted.filter((item) => {
        return (
          typeof item === 'object' &&
          // Check if object is valid
          item.memberOf?.length &&
          // Check if processType is specified and is valid for current process
          (config.processType && item.processType ? config.processType === item.processType : true)
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

  // Check object
  const objectRestrictions = getRestricted(data.constructor) || [];
  if (config.checkObjectItself) {
    const objectIsValid = validateRestricted(objectRestrictions);
    if (!objectIsValid) {
      // Throw error
      if (config.throwError) {
        throw new UnauthorizedException('The current user has no access rights for ' + data.constructor?.name);
      }
      return null;
    }
  }

  // Check properties of object
  for (const propertyKey of Object.keys(data)) {
    // Check undefined
    if (data[propertyKey] === undefined && config.ignoreUndefined) {
      continue;
    }

    // Check restricted
    const restricted = getRestricted(data, propertyKey) || [];
    const concatenatedRestrictions = _.uniq(objectRestrictions.concat(restricted));
    const valid = validateRestricted(concatenatedRestrictions);

    // Check rights
    if (valid) {
      // Check deep
      data[propertyKey] = checkRestricted(data[propertyKey], user, config, processedObjects);
    } else {
      // Throw error
      if (config.throwError) {
        throw new UnauthorizedException(
          'The current user has no access rights for ' +
            propertyKey +
            (data.constructor?.name ? ' of ' + data.constructor.name : '')
        );
      }

      // Remove property
      delete data[propertyKey];
    }
  }

  // Return processed data
  return data;
};
