import { SetMetadata } from '@nestjs/common';

import { CoreModel } from '../models/core-model.model';

/**
 * Metadata key used to store the explicit response model class on a handler.
 * Shared between the @ResponseModel() decorator and interceptor.helper.ts.
 */
export const RESPONSE_MODEL_KEY = 'response_model_class';

/**
 * Decorator to explicitly specify the model class for automatic response conversion.
 *
 * In most cases this is NOT needed because the type is resolved automatically:
 * - GraphQL: from @Query/@Mutation return type metadata
 * - REST: from @ApiOkResponse({ type: Model }) / @ApiCreatedResponse({ type: Model })
 *
 * Use this decorator only when automatic resolution fails or when no Swagger
 * decorators are present on a REST endpoint.
 *
 * @example
 * ```typescript
 * @ResponseModel(User)
 * @Get(':id')
 * async getUser(@Param('id') id: string): Promise<User> {
 *   return this.userService.mainDbModel.findById(id).exec();
 * }
 * ```
 */
export const ResponseModel = (modelClass: new (...args: any[]) => CoreModel) =>
  SetMetadata(RESPONSE_MODEL_KEY, modelClass);
