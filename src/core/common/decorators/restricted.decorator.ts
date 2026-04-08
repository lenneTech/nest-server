import { UnauthorizedException } from '@nestjs/common';
import 'reflect-metadata';
import _ = require('lodash');

import { ProcessType } from '../enums/process-type.enum';
import { RoleEnum } from '../enums/role.enum';
import { equalIds, getIncludedIds } from '../helpers/db.helper';
import { RequestContext } from '../services/request-context.service';
import { RequireAtLeastOne } from '../types/required-at-least-one.type';
import { checkRoleAccess } from '../../modules/tenant/core-tenant.helpers';

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
 * Cache for Restricted metadata — decorators are static, metadata never changes at runtime.
 * WeakMap<CacheTarget, Map<propertyKey | '__class__', RestrictedType>>
 *
 * Uses WeakMap so that dynamically-generated or hot-reloaded class constructors can be GC'd
 * when no longer reachable (prevents unbounded growth in test suites and dev watch mode).
 *
 * CacheTarget is the class constructor (for instances) or the class itself (when object IS a constructor).
 * This distinction is critical: getRestricted(data.constructor) passes a class as `object`,
 * and (classFunction).constructor === Function for ALL classes — so we must use the class itself.
 */
const restrictedMetadataCache = new WeakMap<object, Map<string, RestrictedType>>();

/**
 * Get restricted data for (property of) object
 */
export const getRestricted = (object: unknown, propertyKey?: string): RestrictedType => {
  if (!object) {
    return null;
  }

  // Determine cache target: use the class constructor for instances, the object itself for classes.
  // When object IS a constructor (typeof === 'function'), using object.constructor would give Function
  // for ALL classes, causing cache collisions.
  const cacheTarget: object | undefined =
    typeof object === 'function' ? (object as object) : (object as any).constructor;
  if (!cacheTarget) {
    return propertyKey
      ? Reflect.getMetadata(restrictedMetaKey, object, propertyKey)
      : Reflect.getMetadata(restrictedMetaKey, object);
  }

  let classCache = restrictedMetadataCache.get(cacheTarget);
  if (!classCache) {
    classCache = new Map();
    restrictedMetadataCache.set(cacheTarget, classCache);
  }

  const cacheKey = propertyKey || '__class__';
  if (classCache.has(cacheKey)) {
    return classCache.get(cacheKey);
  }

  // Cache miss: perform Reflect lookup and cache the result
  const metadata = propertyKey
    ? Reflect.getMetadata(restrictedMetaKey, object, propertyKey)
    : Reflect.getMetadata(restrictedMetaKey, object);

  classCache.set(cacheKey, metadata);
  return metadata;
};

/**
 * Check data for restricted properties (properties with `Restricted` decorator)
 * For special Roles and member of group checking the dbObject must be set in options
 */
export const checkRestricted = (
  data: any,
  user: {
    emailVerified?: any;
    hasRole: (roles: string[]) => boolean;
    id: any;
    roles?: string[];
    verified?: any;
    verifiedAt?: any;
  },
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
  processedObjects: WeakSet<object> = new WeakSet(),
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

  // Prevent infinite recursion
  if (processedObjects.has(data)) {
    return data;
  }
  processedObjects.add(data);

  // Array
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return data;
    }

    // Optimization for typed arrays: all items share the same class → same @Restricted metadata.
    // Validate restrictions on the first item, then apply the result to all items.
    // Per-item checks are only needed when S_CREATOR or S_SELF restrictions exist
    // (because createdBy/id differ per item).
    const sample = data[0];
    if (
      sample &&
      typeof sample === 'object' &&
      !Array.isArray(sample) &&
      sample.constructor &&
      sample.constructor !== Object
    ) {
      // Check class-level restrictions once
      const classRestrictions = getRestricted(sample.constructor) || [];
      if (classRestrictions.length) {
        const hasCreatorOrSelf = classRestrictions.some(
          (r) =>
            // Bare role string: @Restricted(RoleEnum.S_CREATOR)
            r === RoleEnum.S_CREATOR ||
            r === RoleEnum.S_SELF ||
            // Role array: @Restricted([RoleEnum.S_CREATOR, RoleEnum.ADMIN])
            (Array.isArray(r) && (r.includes(RoleEnum.S_CREATOR) || r.includes(RoleEnum.S_SELF))) ||
            // Object with roles: @Restricted({ roles: RoleEnum.S_CREATOR }) or { roles: [...] }
            (typeof r === 'object' &&
              !Array.isArray(r) &&
              'roles' in r &&
              r.roles &&
              ((Array.isArray(r.roles) &&
                (r.roles.includes(RoleEnum.S_CREATOR) || r.roles.includes(RoleEnum.S_SELF))) ||
                r.roles === RoleEnum.S_CREATOR ||
                r.roles === RoleEnum.S_SELF)),
        );

        if (!hasCreatorOrSelf) {
          // No per-item ownership checks needed — validate one sample, apply to all.
          // The sample check recurses into properties. With checkObjectItself=true, it
          // also validates the class-level restriction as a standalone gate. With the
          // default checkObjectItself=false, class restrictions are merged into each
          // property's restrictions (properties get stripped if the class restriction denies).
          const sampleResult = checkRestricted(sample, user, config, processedObjects);
          if (sampleResult === undefined || sampleResult === null) {
            // Class-level restriction blocks access → entire array is blocked
            if (config.throwError) {
              return data; // Exception was already thrown in sampleResult
            }
            return config.removeUndefinedFromResultArray ? [] : data.map(() => undefined);
          }
          // Sample passed — process remaining items with the same (cached) restriction lookups.
          // Since getRestricted() uses a WeakMap cache, subsequent calls for the same class
          // are O(1) lookups, but we still need to recurse into nested properties per item.
          const result = [sampleResult];
          for (let i = 1; i < data.length; i++) {
            result.push(checkRestricted(data[i], user, config, processedObjects));
          }
          if (!config.throwError && config.removeUndefinedFromResultArray) {
            return result.filter((item) => item !== undefined);
          }
          return result;
        }
      }
    }

    // Fallback: plain objects, mixed types, or S_CREATOR/S_SELF checks needed
    let result = data.map((item) => checkRestricted(item, user, config, processedObjects));
    if (!config.throwError && config.removeUndefinedFromResultArray) {
      result = result.filter((item) => item !== undefined);
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
        item?.roles?.length &&
        (config.processType && item.processType ? config.processType === item.processType : true)
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
        roles.includes(RoleEnum.S_EVERYONE) ||
        user?.hasRole?.(roles) ||
        (user?.id && roles.includes(RoleEnum.S_USER)) ||
        (roles.includes(RoleEnum.S_SELF) && equalIds(data, user)) ||
        (roles.includes(RoleEnum.S_CREATOR) &&
          (('createdBy' in data && equalIds(data.createdBy, user)) ||
            (config.allowCreatorOfParent && !('createdBy' in data) && config.isCreatorOfParent))) ||
        (roles.includes(RoleEnum.S_VERIFIED) && (user?.verified || user?.verifiedAt || user?.emailVerified)) ||
        (user?.id && checkRoleAccess(roles, user?.roles, RequestContext.get()?.tenantRole))
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
                members.push(...items);
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
    const concatenatedRestrictions =
      config.mergeRoles && objectRestrictions.length ? _.uniq(objectRestrictions.concat(restricted)) : restricted;
    const valid = validateRestricted(concatenatedRestrictions);

    // Check rights
    if (valid) {
      // Check if data is user or user is creator of data (for nested plain objects)
      config.isCreatorOfParent =
        equalIds(data, user) || ('createdBy' in data ? equalIds(data.createdBy, user) : config.isCreatorOfParent);

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
