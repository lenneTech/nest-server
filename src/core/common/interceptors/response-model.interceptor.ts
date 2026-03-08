import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { resolveResponseModelClass } from '../helpers/interceptor.helper';
import { CoreModel } from '../models/core-model.model';
import { ConfigService } from '../services/config.service';
import { ModelRegistry } from '../services/model-registry.service';

/**
 * Interceptor that automatically converts plain objects and Mongoose documents
 * to CoreModel instances, enabling securityCheck() and @Restricted metadata.
 *
 * This is the safety net that ensures output security even when developers
 * bypass CrudService.process() and use direct Mongoose queries.
 *
 * Execution order on response (NestJS runs APP_INTERCEPTOR in reverse registration order):
 * 1. ResponseModelInterceptor (registered last → runs first on response)
 * 2. CheckSecurityInterceptor (processes securityCheck())
 * 3. CheckResponseInterceptor (filters @Restricted fields)
 */
@Injectable()
export class ResponseModelInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ResponseModelInterceptor.name);
  private config = {
    debug: false,
  };

  constructor(private readonly configService: ConfigService) {
    const configuration = this.configService.getFastButReadOnly('security.responseModelInterceptor');
    if (typeof configuration === 'object') {
      this.config = { ...this.config, ...configuration };
    }
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const modelClass = resolveResponseModelClass(context);

    return next.handle().pipe(
      map((data) => {
        if (!modelClass || data === null || data === undefined || typeof data !== 'object') {
          return data;
        }

        // Already the correct model instance
        if (data instanceof modelClass) {
          return data;
        }

        // Already processed by another interceptor
        if (data._objectAlreadyCheckedForRestrictions) {
          return data;
        }

        return this.convertToModel(data, modelClass, context);
      }),
    );
  }

  private convertToModel(data: any, modelClass: new (...args: any[]) => CoreModel, context: ExecutionContext): any {
    // Scalars/primitives pass through
    if (typeof data !== 'object' || data === null) {
      return data;
    }

    // Array of items
    if (Array.isArray(data)) {
      return data.map((item) => this.convertSingleItem(item, modelClass, context));
    }

    // Wrapper objects (e.g. { items: [...], totalCount, pagination })
    if (data.items && Array.isArray(data.items) && !data.securityCheck) {
      data.items = data.items.map((item: any) => this.convertSingleItem(item, modelClass, context));
      return data;
    }

    // Single object
    return this.convertSingleItem(data, modelClass, context);
  }

  private convertSingleItem(item: any, modelClass: new (...args: any[]) => CoreModel, context: ExecutionContext): any {
    if (item === null || item === undefined || typeof item !== 'object') {
      return item;
    }

    // Already the correct type
    if (item instanceof modelClass) {
      return item;
    }

    // Already processed
    if (item._objectAlreadyCheckedForRestrictions) {
      return item;
    }

    // Convert Mongoose document to plain object first
    const plain = typeof item.toObject === 'function' ? item.toObject() : item;

    try {
      const mapped = (modelClass as any).map(plain);
      if (this.config.debug) {
        const className = context.getClass()?.name;
        const methodName = context.getHandler()?.name;
        this.logger.warn(
          `Auto-converted plain object to ${modelClass.name} in ${className}.${methodName}. Consider using CrudService methods.`,
        );
      }
      return mapped;
    } catch {
      // If mapping fails, try resolving via ModelRegistry using the Mongoose model name
      return this.tryRegistryFallback(plain) || item;
    }
  }

  private tryRegistryFallback(item: any): any {
    // Mongoose documents have a collection property with modelName
    const modelName = item?.constructor?.modelName || item?.collection?.modelName;
    if (!modelName) {
      return null;
    }

    const registeredClass = ModelRegistry.getModelClass(modelName);
    if (!registeredClass) {
      return null;
    }

    try {
      const plain = typeof item.toObject === 'function' ? item.toObject() : item;
      return (registeredClass as any).map(plain);
    } catch {
      return null;
    }
  }
}
