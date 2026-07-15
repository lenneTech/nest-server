/**
 * Cloning / freezing helpers.
 *
 * These live in their own file — instead of `input.helper.ts` — so that `config.service` can reach
 * them without importing `input.helper`, which imports `restricted.decorator` behind it.
 *
 * That edge closed a runtime cycle:
 *
 *   restricted.decorator → tenant/core-tenant.helpers → config.service → input.helper
 *                        → restricted.decorator
 *
 * so `input.helper` evaluated while `restricted.decorator` was still initializing. Nothing crashed,
 * but only because every cross-cycle dereference sat inside a function body. A single top-level line
 * in `input.helper` — a module-level alias of `checkRestricted`, an `@Restricted`-decorated class,
 * `design:type` metadata — would have thrown under SWC → CommonJS:
 *
 *   ReferenceError: Cannot access 'checkRestricted' before initialization
 *
 * …in the file that drives field-level access control, on a compiler this repo's default build never
 * runs, with a green test suite. Moving these two pure functions out removes the edge, so the cycle
 * no longer exists rather than merely being disarmed.
 *
 * This file imports only Node built-ins, lodash and rfdc — no framework code — so it can never be
 * part of a cycle itself. Keep it that way.
 *
 * `input.helper` re-exports both functions, so every existing import path keeps working.
 * See .claude/rules/architecture.md → "DI Token Placement (SWC-Safe)".
 */
import * as inspector from 'inspector';
import _ = require('lodash');
import rfdc = require('rfdc');
import * as util from 'util';

/**
 * Get clone of object
 *
 * @param object Object to clone
 * @param options Options for cloning
 * @param options.checkResult Whether to check the result of the cloning process
 * @param options.circles Keeping track of circular references will slow down performance with an additional 25% overhead.
 *                        Even if an object doesn't have any circular references, the tracking overhead is the cost.
 *                        By default if an object with a circular reference is passed to rfdc, it will throw
 *                        (similar to how JSON.stringify would throw). Use the circles option to detect and preserve
 *                        circular references in the object. If performance is important, try removing the circular
 *                        reference from the object (set to undefined) and then add it back manually after cloning
 *                        instead of using this option.
 * @param options.proto Copy prototype properties as well as own properties into the new object.
 *                      It's marginally faster to allow enumerable properties on the prototype to be copied into the
 *                      cloned object (not onto it's prototype, directly onto the object).
 */
export function clone(object: any, options?: { checkResult?: boolean; circles?: boolean; proto?: boolean }) {
  const config = {
    checkResult: true,
    circles: true,
    debug: inspector.url() !== undefined,
    proto: false,
    ...options,
  };

  try {
    const cloned = rfdc(config)(object);
    if (config.checkResult && !util.isDeepStrictEqual(object, cloned)) {
      throw new Error('Cloned object differs from original object');
    }
    return cloned;
  } catch (e) {
    if (!config.circles) {
      if (config.debug) {
        console.debug(e, config, object, 'automatic try to use rfdc with circles');
      }
      try {
        const clonedWithCircles = rfdc({
          ...config,
          circles: true,
        })(object);
        if (config.checkResult && !util.isDeepStrictEqual(object, clonedWithCircles)) {
          throw new Error('Cloned object differs from original object', { cause: e });
        }
        return clonedWithCircles;
      } catch (innerError) {
        if (config.debug) {
          console.debug(innerError, 'rfcd with circles did not work => automatic use of _.clone!');
        }
        return _.cloneDeep(object);
      }
    } else {
      if (config.debug) {
        console.debug(e, config, object, 'automatic try to use _.clone instead rfdc');
      }
      return _.cloneDeep(object);
    }
  }
}

/**
 * Get deep frozen object
 */
export function deepFreeze(object: any, visited: WeakSet<object> = new WeakSet()) {
  if (!object || typeof object !== 'object') {
    return object;
  }
  if (visited.has(object)) {
    return object;
  }
  visited.add(object);
  for (const [key, value] of Object.entries(object)) {
    object[key] = deepFreeze(value, visited);
  }
  return Object.freeze(object);
}
