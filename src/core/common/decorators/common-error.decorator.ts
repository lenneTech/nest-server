import { applyDecorators } from '@nestjs/common';
import { ApiBadRequestResponse, ApiNotFoundResponse, ApiUnauthorizedResponse } from '@nestjs/swagger';

export const commonErrorSchema = {
  properties: {
    message: { type: 'string' },
    name: { type: 'string' },
    options: { type: 'object' },
    response: {
      properties: {
        error: { type: 'string' },
        message: { type: 'string' },
        statusCode: { type: 'number' },
      },
      type: 'object',
    },
    status: { type: 'number' },
  },
  type: 'object',
};

export const badRequestSchema = {
  properties: {
    message: { type: 'string' },
    name: { type: 'string' },
    options: {
      additionalProperties: true,
      type: 'object',
    },
    response: {
      additionalProperties: {
        additionalProperties: {
          type: 'string',
        },
        type: 'object',
      },
      type: 'object',
    },
    status: { type: 'number' },
  },
  type: 'object',
};

export function ApiCommonErrorResponses() {
  return applyDecorators(
    ApiUnauthorizedResponse({ schema: commonErrorSchema }),
    ApiNotFoundResponse({ schema: commonErrorSchema }),
    ApiBadRequestResponse({ schema: badRequestSchema }),
  );
}
