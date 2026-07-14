/**
 * ID helpers.
 *
 * These live in their own file — instead of `db.helper.ts` — so that files which need nothing but
 * ID comparison can reach them without importing `db.helper`, which drags in GraphQL, Mongoose
 * models and `input.helper` behind it.
 *
 * That was not an aesthetic choice. `restricted.decorator.ts` needs exactly two of these functions
 * (`equalIds`, `getIncludedIds`), and importing them from `db.helper` put it on a real runtime
 * cycle:
 *
 *   restricted.decorator → db.helper → input.helper → restricted.decorator
 *
 * `input.helper` therefore evaluated while `restricted.decorator` was still initializing. Nothing
 * crashed, but only because every cross-cycle dereference happened to sit inside a function body:
 * a single top-level line in `input.helper` (a module-level alias, an `@Restricted`-decorated class,
 * `design:type` metadata) would have thrown under SWC → CommonJS:
 *
 *   ReferenceError: Cannot access 'checkRestricted' before initialization
 *
 * …in the file that drives field-level access control, on a compiler this repo's default build never
 * runs. Moving the ID cluster into this leaf removes the `restricted.decorator → db.helper` edge
 * outright, so the cycle no longer exists rather than merely being disarmed.
 *
 * This file imports only Mongoose's `Types`, lodash, and a type — no framework code — so it can
 * never be part of a cycle itself. Keep it that way.
 *
 * `db.helper` re-exports all four public functions, so every existing import path keeps working.
 * See .claude/rules/architecture.md → "DI Token Placement (SWC-Safe)".
 */
import _ = require('lodash');
import { Types } from 'mongoose';

import { IdsType } from '../types/ids.type';

/**
 * Checks if all IDs are equal
 */
export function equalIds(...ids: IdsType[]): boolean {
  if (!ids) {
    return false;
  }
  const compare = getStringIds(ids[0]);
  if (!compare) {
    return false;
  }
  return ids.every((id) => getStringIds(id) === compare);
}

/**
 * Get included ids
 * @param includes IdsType, which should be checked if it contains the ID
 * @param ids IdsType, which should be included
 * @param convert If set the result array will be converted to pure type String array or ObjectId array
 * @return IdsType with IDs which are included, undefined if includes or ids are missing or null if none is included
 */
export function getIncludedIds(includes: IdsType, ids: IdsType, convert?: 'string'): string[];
export function getIncludedIds(includes: IdsType, ids: IdsType, convert?: 'object'): Types.ObjectId[];

export function getIncludedIds<T = IdsType>(
  includes: IdsType,
  ids: IdsType | T,
  convert?: 'object' | 'string',
): null | T[] | undefined {
  if (!includes || !ids) {
    return undefined;
  }

  if (!Array.isArray(includes)) {
    includes = [includes];
  }

  if (!Array.isArray(ids)) {
    ids = [ids];
  }

  let result = [];
  const includesStrings = getStringIds(includes);
  for (const id of ids) {
    if (includesStrings.includes(getStringIds(id))) {
      result.push(id);
    }
  }

  if (convert) {
    result = convert === 'string' ? getStringIds(result) : getObjectIds(result);
  }

  return result.length ? result : null;
}

/**
 * Convert string(s) to ObjectId(s)
 */
export function getObjectIds(ids: any[]): Types.ObjectId[];
export function getObjectIds(ids: any): Types.ObjectId;
export function getObjectIds<T extends any | any[]>(ids: T): Types.ObjectId | Types.ObjectId[] {
  if (Array.isArray(ids)) {
    return ids.map((id) => new Types.ObjectId(getStringId(id)));
  }
  return new Types.ObjectId(getStringId(ids));
}

/**
 * Get IDs from string of ObjectId array in a flat string array
 */
export function getStringIds(elements: any[], options?: { deep?: boolean; unique?: boolean }): string[];

export function getStringIds(elements: any, options?: { deep?: boolean; unique?: boolean }): string;

export function getStringIds<T extends any | any[]>(
  elements: T,
  options?: { deep?: boolean; unique?: boolean },
): string | string[] {
  // Process options
  const { deep, unique } = {
    deep: false,
    unique: false,
    ...options,
  };

  // Check elements
  if (!elements) {
    return elements as any;
  }

  // Init ids
  let ids = [];

  // Process non array
  if (!Array.isArray(elements)) {
    return getStringId(elements);
  }

  // Process array
  for (const element of elements) {
    if (Array.isArray(element)) {
      if (deep) {
        ids = ids.concat(getStringIds(element, { deep }));
      }
    } else {
      const id = getStringId(element);
      if (id) {
        ids.push(id);
      }
    }
  }

  // Return (unique) ID array
  return unique ? _.uniq(ids) : ids;
}

// =====================================================================================================================
// Not exported helper functions
// =====================================================================================================================

/**
 * Get ID of element as string
 */
function getStringId(element: any): string {
  // Check element
  if (!element) {
    return element;
  }

  // Buffer handling
  if (element instanceof Buffer) {
    return element.toString();
  }

  // String handling
  if (typeof element === 'string') {
    return element;
  }

  // Object handling
  if (typeof element === 'object') {
    if (element instanceof Types.ObjectId) {
      return element.toHexString();
    }

    if (element.id) {
      if (element.id instanceof Buffer && element.toHexString) {
        return element.toHexString();
      }
      return getStringId(element.id);
    } else if (element._id) {
      return getStringId(element._id);
    }
  }

  // Other types
  if (typeof element.toString === 'function') {
    return element.toString();
  }

  return undefined;
}
