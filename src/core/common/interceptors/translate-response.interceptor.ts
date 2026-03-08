import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { applyTranslationsRecursively } from '../helpers/service.helper';

/**
 * Interceptor that automatically applies translations from _translations
 * based on the Accept-Language header of the request.
 *
 * This ensures translations work even when developers bypass CrudService.process()
 * and use direct Mongoose operations.
 *
 * Execution order on response:
 * 1. ResponseModelInterceptor (plain → model)
 * 2. TranslateResponseInterceptor (applies translations) ← THIS
 * 3. CheckSecurityInterceptor (securityCheck())
 * 4. CheckResponseInterceptor (@Restricted fields)
 */
@Injectable()
export class TranslateResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const language = this.getLanguage(context);

    if (!language) {
      return next.handle();
    }

    return next.handle().pipe(
      map((data) => {
        if (!data || typeof data !== 'object') {
          return data;
        }
        this.applyTranslations(data, language);
        return data;
      }),
    );
  }

  private applyTranslations(data: any, language: string): void {
    // Early bailout: skip if no _translations anywhere in the response
    if (!this.hasTranslations(data)) {
      return;
    }

    if (Array.isArray(data)) {
      for (const item of data) {
        if (item && typeof item === 'object') {
          applyTranslationsRecursively(item, language);
        }
      }
    } else if (data.items && Array.isArray(data.items)) {
      // Wrapper objects (e.g. { items: [...], totalCount })
      for (const item of data.items) {
        if (item && typeof item === 'object') {
          applyTranslationsRecursively(item, language);
        }
      }
    } else {
      applyTranslationsRecursively(data, language);
    }
  }

  /**
   * Quick check if _translations exists at the top level of the response.
   * Avoids expensive recursive traversal when no translations are present.
   */
  private hasTranslations(data: any): boolean {
    if (!data || typeof data !== 'object') {
      return false;
    }
    if (Array.isArray(data)) {
      return data.length > 0 && data[0] && typeof data[0] === 'object' && '_translations' in data[0];
    }
    if (data.items && Array.isArray(data.items)) {
      return (
        data.items.length > 0 && data.items[0] && typeof data.items[0] === 'object' && '_translations' in data.items[0]
      );
    }
    return '_translations' in data;
  }

  private getLanguage(context: ExecutionContext): string | null {
    // GraphQL context
    try {
      if (context.getType<GqlContextType>() === 'graphql') {
        const gqlContext = GqlExecutionContext.create(context);
        const req = gqlContext.getContext()?.req;
        return req?.headers?.['accept-language'] || null;
      }
    } catch {
      // Not a GraphQL context
    }

    // HTTP context
    try {
      const req = context.switchToHttp()?.getRequest();
      return req?.headers?.['accept-language'] || null;
    } catch {
      return null;
    }
  }
}
