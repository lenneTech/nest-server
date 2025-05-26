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

export function updateLanguage<T extends Record<string, any>, K extends readonly (keyof T)[]>(
  language: string,
  input: any,
  oldValue: T,
  translatableFields: string[],
): T {
  const changedFields: Partial<Pick<T, K[number]>> = {};

  for (const key of translatableFields) {
    const k = key as keyof T;

    if (input[k] !== oldValue[k] && input[k] !== undefined) {
      changedFields[k] = input[k];
      input[k] = oldValue[k] as T[typeof k];
    }
  }

  input._translations = input._translations ?? {};
  input._translations[language] = {
    ...(input._translations[language] ?? {}),
    ...changedFields,
  };
  return input;
}
