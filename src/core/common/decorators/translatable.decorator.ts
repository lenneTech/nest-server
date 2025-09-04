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

export function updateLanguage(language, input, oldValue, translatableFields) {
  const changedFields = {};
  for (const key of translatableFields) {
    const k = key;

    // For languages other than 'de', compare with existing translation value instead of main value
    let compareValue;
    if (language !== 'de' && oldValue._translations?.[language]?.[k] !== undefined) {
      compareValue = oldValue._translations[language][k];
    } else {
      compareValue = oldValue[k];
    }

    if (input[k] !== compareValue && input[k] !== undefined) {
      changedFields[k] = input[k];
      // Only reset if the current field isn't in german
      if (language !== 'de') {
        input[k] = oldValue[k];
      }
    } else if (language !== 'de' && input[k] !== undefined) {
      // If no change detected but we have input for this field, reset to original value
      // to prevent overwriting the default with translation values
      input[k] = oldValue[k];
    }
  }
  input._translations = input._translations ?? {};
  input._translations[language] = {
    ...(input._translations[language] ?? {}),
    ...changedFields,
  };
  return input;
}
