import 'reflect-metadata';

const TRANSLATABLE_KEY = 'custom:translatable';

export function getTranslatablePropertyKeys(target: unknown): string[] {
  // for classes
  if (typeof target === 'function') {
    return Reflect.getMetadata(TRANSLATABLE_KEY, target) || [];
  }

  // for instances
  if (typeof target === 'object' && target.constructor) {
    return Reflect.getMetadata(TRANSLATABLE_KEY, target.constructor) || [];
  }

  return [];
}

export function Translatable(): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    const existingProperties: string[] = Reflect.getMetadata(TRANSLATABLE_KEY, target.constructor) || [];
    Reflect.defineMetadata(TRANSLATABLE_KEY, [...existingProperties, propertyKey], target.constructor);
  };
}
