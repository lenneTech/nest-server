import { FieldMiddleware, MiddlewareContext, NextFn } from '@nestjs/graphql';

/**
 * Field middleware to convert string to lowercase letters
 */
export const toLowerCase: FieldMiddleware = async (ctx: MiddlewareContext, next: NextFn) => {
  const value = await next();
  return value?.toLowerCase();
};
