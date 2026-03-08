import { ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';

import { CoreModel } from '../models/core-model.model';

const RESPONSE_MODEL_KEY = 'response_model_class';

// Cache: handler function → resolved model class (or null)
// Handler references are stable per route, so the cache is bounded by the number of routes.
const resolvedModelCache = new Map<Function, (new (...args: any[]) => CoreModel) | null>();

/**
 * Resolve the expected model class for a handler's response.
 * Results are cached per handler function for zero-cost subsequent lookups.
 *
 * Priority:
 * 1. Explicit @ResponseModel(ModelClass) decorator
 * 2. GraphQL TypeMetadataStorage lookup (automatic for @Query/@Mutation)
 * 3. Swagger @ApiOkResponse / @ApiCreatedResponse type (automatic for REST)
 * 4. null (no auto-mapping)
 */
export function resolveResponseModelClass(context: ExecutionContext): (new (...args: any[]) => CoreModel) | null {
  const handler = context.getHandler();

  // Return cached result (hit after first request per route)
  if (resolvedModelCache.has(handler)) {
    return resolvedModelCache.get(handler);
  }

  const result = resolveResponseModelClassUncached(context, handler);
  resolvedModelCache.set(handler, result);
  return result;
}

function resolveResponseModelClassUncached(
  context: ExecutionContext,
  handler: Function,
): (new (...args: any[]) => CoreModel) | null {
  // 1. Explicit @ResponseModel decorator
  const explicit = Reflect.getMetadata(RESPONSE_MODEL_KEY, handler);
  if (explicit) {
    return explicit;
  }

  // 2. GraphQL TypeMetadataStorage lookup
  try {
    const gqlContext = GqlExecutionContext.create(context);
    const info = gqlContext.getInfo?.();
    if (info) {
      return resolveFromGraphQlMetadata(context);
    }
  } catch {
    // Not a GraphQL context
  }

  // 3. Swagger @ApiOkResponse / @ApiCreatedResponse type (for REST controllers)
  const swaggerType = resolveFromSwaggerMetadata(handler);
  if (swaggerType) {
    return swaggerType;
  }

  return null;
}

/**
 * Resolve model class from GraphQL @Query/@Mutation metadata
 */
function resolveFromGraphQlMetadata(context: ExecutionContext): (new (...args: any[]) => CoreModel) | null {
  try {
    // Dynamic import to avoid hard dependency on @nestjs/graphql internals
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { TypeMetadataStorage } = require('@nestjs/graphql/dist/schema-builder/storages/type-metadata.storage');

    const handler = context.getHandler();
    const target = context.getClass();
    const methodName = handler.name;

    // Search queries and mutations
    const allMetadata = [...TypeMetadataStorage.getQueriesMetadata(), ...TypeMetadataStorage.getMutationsMetadata()];

    const meta = allMetadata.find((m: any) => m.target === target && m.methodName === methodName);

    if (meta?.typeFn) {
      const resolvedType = meta.typeFn();
      if (resolvedType && typeof resolvedType === 'function' && isCoreModelSubclass(resolvedType)) {
        return resolvedType as new (...args: any[]) => CoreModel;
      }
    }
  } catch {
    // TypeMetadataStorage not available or other issue
  }

  return null;
}

/**
 * Resolve model class from Swagger @ApiOkResponse / @ApiCreatedResponse metadata.
 * Reads the `type` from the response metadata stored by @nestjs/swagger decorators.
 */
function resolveFromSwaggerMetadata(handler: Function): (new (...args: any[]) => CoreModel) | null {
  try {
    const SWAGGER_API_RESPONSE_KEY = 'swagger/apiResponse';
    const responses = Reflect.getMetadata(SWAGGER_API_RESPONSE_KEY, handler);
    if (!responses || typeof responses !== 'object') {
      return null;
    }

    // Check common success status codes (200 OK, 201 Created)
    for (const statusCode of [200, 201]) {
      const responseMeta = responses[statusCode];
      if (responseMeta?.type && typeof responseMeta.type === 'function' && isCoreModelSubclass(responseMeta.type)) {
        return responseMeta.type as new (...args: any[]) => CoreModel;
      }
    }
  } catch {
    // Swagger not available or metadata not found
  }

  return null;
}

function isCoreModelSubclass(cls: Function): boolean {
  let proto = cls.prototype;
  while (proto) {
    if (proto.constructor === CoreModel || proto.constructor?.name === 'CoreModel') {
      return true;
    }
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}
