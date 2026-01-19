import { Injectable } from '@nestjs/common';

import { getAllErrorDefinitions, IErrorRegistry } from './error-codes';
import { SupportedLocale } from './interfaces/error-code.interfaces';

/**
 * Core Error Code Service
 *
 * Serves error code translations from the structured ErrorRegistry.
 * Translations are defined in error-codes.ts as Single Source of Truth.
 *
 * Projects can extend this service to add custom error registries.
 *
 * @example
 * ```typescript
 * // In consuming project:
 * import { CoreErrorCodeService, IErrorRegistry } from '@lenne.tech/nest-server';
 *
 * const ProjectErrors = {
 *   ORDER_NOT_FOUND: {
 *     code: 'PROJ_0001',
 *     message: 'Order not found',
 *     translations: { de: 'Bestellung nicht gefunden.', en: 'Order not found.' }
 *   }
 * } as const satisfies IErrorRegistry;
 *
 * @Injectable()
 * export class ErrorCodeService extends CoreErrorCodeService {
 *   constructor() {
 *     super();
 *     this.registerErrorRegistry(ProjectErrors);
 *   }
 * }
 * ```
 */
@Injectable()
export class CoreErrorCodeService {
  /**
   * Supported locales
   */
  protected supportedLocales: SupportedLocale[] = ['de', 'en'];

  /**
   * Cached translations per locale
   */
  protected translations: Map<SupportedLocale, Record<string, string>> = new Map();

  /**
   * Registered error registries
   */
  protected registries: IErrorRegistry[] = [];

  constructor() {
    // Initialize with core errors
    this.registerErrorRegistry(getAllErrorDefinitions());
  }

  /**
   * Register an error registry and generate translations
   *
   * @param registry - Error registry to register
   */
  registerErrorRegistry(registry: IErrorRegistry): void {
    this.registries.push(registry);
    this.generateTranslationsFromRegistry(registry);
  }

  /**
   * Generate translations from error registry
   *
   * @param registry - Error registry to extract translations from
   */
  protected generateTranslationsFromRegistry(registry: IErrorRegistry): void {
    for (const [, definition] of Object.entries(registry)) {
      const { code, translations: defTranslations } = definition;

      for (const locale of this.supportedLocales) {
        const translation = defTranslations[locale];
        if (translation) {
          const existing = this.translations.get(locale) || {};
          this.translations.set(locale, { ...existing, [code]: translation });
        }
      }
    }
  }

  /**
   * Check if a locale is supported
   *
   * @param locale - Locale to check
   * @returns True if locale is supported
   */
  isLocaleSupported(locale: string): locale is SupportedLocale {
    return this.supportedLocales.includes(locale as SupportedLocale);
  }

  /**
   * Get supported locales
   *
   * @returns Array of supported locales
   */
  getSupportedLocales(): SupportedLocale[] {
    return [...this.supportedLocales];
  }

  /**
   * Get all translations for a locale
   *
   * @param locale - Locale code (e.g., 'de', 'en')
   * @returns Translations object wrapped in { errors: ... } for Nuxt i18n compatibility
   * @throws Error if locale is not supported
   */
  getTranslations(locale: SupportedLocale): { errors: Record<string, string> } {
    if (!this.isLocaleSupported(locale)) {
      throw new Error(`Locale "${locale}" is not supported. Supported: ${this.supportedLocales.join(', ')}`);
    }

    return { errors: this.translations.get(locale) || {} };
  }

  /**
   * Get all error codes
   *
   * @returns Array of error codes from all registries
   */
  getErrorCodes(): string[] {
    const codes = new Set<string>();
    for (const translations of this.translations.values()) {
      for (const code of Object.keys(translations)) {
        codes.add(code);
      }
    }
    return Array.from(codes).sort();
  }
}
