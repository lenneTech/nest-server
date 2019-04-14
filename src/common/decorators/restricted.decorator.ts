import "reflect-metadata";

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
export const getRestricted = (object: any, propertyKey: string) => {
  return Reflect.getMetadata(restrictedMetaKey, object, propertyKey);
};
